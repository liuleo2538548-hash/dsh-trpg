/**
 * dsh-trpg — GM 人格：吐槽、语气、指令解析。
 *
 * 职责边界：**只负责「怎么说」，不负责「怎么判定」**。
 * 贿赂是否成立、指令是否执行、骰子怎么掷，全在 bribe.js / commands.js / dice.js；
 * 本模块只把已经定好的结果翻译成一句有脾气的中文。
 *
 * 吐槽库的布局（本模块的主体资产，全部是手写文案，不是模板拼接）：
 *   - KIND_LINES[kind]    —— 按「时刻」组织的通用池，与 mood 无关（每个 kind 6 条）
 *   - MOOD_LINES[mood]    —— 按「情绪」组织的通用池，与 kind 无关（每个 mood 6 条）
 *   - COMBO_LINES["m|k"]  —— 最常出现的 (mood,kind) 交叉池（每组 3 条）
 *   - TONE_LINES[tone]    —— 基调池（未知基调回落为空）
 *   snarkLine 的实际候选 = 以上四者的并集（顺序保留、去重），因此**任何** (mood,kind)
 *   组合都至少有 12 条候选（kind 6 + mood 6），高于契约要求的「每个组合 ≥ 6 条」；
 *   库里的字面量句子全局唯一，由 test/gm.test.js 直接扫源码断言。
 *
 * 随机性：任何随机都走注入的 `rng()`；省略时回落到 `Math.random`（契约允许固定回退）。
 * 本模块刻意**不 import dice.js** —— 契约要求三个纯模块互不 import。
 */

/** GM 的八种情绪，宿主用它挑表情与口吻。顺序即「从平稳到失控」。 */
export const MOODS = ["neutral", "pleased", "amused", "impressed", "skeptical", "annoyed", "ominous", "exasperated"];

/** 吐槽的八个时刻。`any` 是万能池，其余对齐跑团里最常出现的情形。 */
const KINDS = ["any", "open", "good", "bad", "critical", "fumble", "bribe", "idle"];

/** 四种基调。未知基调回落通用池，不抛错。 */
const TONES = ["恐怖", "轻松", "沙雕", "硬核"];

/** 贿赂的四种结果。未知 verdict 一律按 refused 处理。 */
const BRIBE_VERDICTS = ["granted", "haggle", "refused", "cold"];

/** styleBrief 的缺省吐槽浓度（与 schema.js 的 LIMITS.fields.snark.fallback 对齐）。 */
const DEFAULT_SNARK = 3;

/** 单行吐槽 / 旁白的字数上限（按码点计）。 */
const SNARK_MAX = 40;
const BRIBE_MAX = 60;

/** NPC 名与价格插入旁白时的截断上限，用来守住单行 60 字上限。 */
const NPC_MAX = 12;
const PRICE_MAX = 20;

/* --------------------------------------------------------------- 情绪基础件 */

/**
 * 把任意值收敛成合法 mood；不在 MOODS 内一律回落 "neutral"。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMood(value) {
  if (typeof value !== "string") return "neutral";
  const key = value.trim().toLowerCase();
  return MOODS.includes(key) ? key : "neutral";
}

/** 每个 mood 一个字符；八者的码点互不相同。 */
const MOOD_EMOJI = {
  neutral: "🎲",
  pleased: "😊",
  amused: "😏",
  impressed: "😮",
  skeptical: "🧐",
  annoyed: "😤",
  ominous: "💀",
  exasperated: "😑",
};

/**
 * mood 对应的一个字符表情。
 * @param {unknown} mood
 * @returns {string}
 */
export function moodEmoji(mood) {
  return MOOD_EMOJI[normalizeMood(mood)];
}

/** 固定映射，纯装饰：不同情绪借用不同系统的称呼。 */
const MOOD_SPEAKER = {
  neutral: "GM",
  pleased: "GM",
  amused: "KP",
  impressed: "DM",
  skeptical: "KP",
  annoyed: "DM",
  ominous: "KP",
  exasperated: "GM",
};

/**
 * mood 对应的说话人标签（"GM" / "KP" / "DM"），纯装饰。
 * @param {unknown} mood
 * @returns {string}
 */
export function speakerFor(mood) {
  return MOOD_SPEAKER[normalizeMood(mood)] || "GM";
}

/* ==== 吐槽库开始 ==== */

/** 按时刻（kind）组织的通用吐槽池，与 mood 无关。 */
const KIND_LINES = {
  any: [
    "你想清楚了再开口，我不催。",
    "行，你说了算，后果你接着。",
    "别看我，我只负责描述世界。",
    "这一步你自己走，我不扶。",
    "我先记下，回头你会想起来的。",
    "好，你定，我跟着演。",
  ],
  open: [
    "灯亮起来的时候，没人注意到你进来。",
    "门一开，冷气先扑过来，然后是味道。",
    "雨还在下，你的鞋已经湿透了。",
    "走廊很长，两侧的门都关着。",
    "有人在等你，但没说等多久。",
    "空气里有股铁锈味，你先记住了。",
  ],
  good: [
    "成了，比我预想的干净。",
    "这一下漂亮，我承认。",
    "门开了，没发出一点声音。",
    "你手很稳，运气也没跑。",
    "行家出手，我不多嘴。",
    "顺利得让我有点不习惯。",
  ],
  bad: [
    "没成。世界不会因为你努力就松口。",
    "差一点，差一点也是差。",
    "你听见了不该听见的声音。",
    "手滑了，代价马上就到。",
    "事与愿违，这是常态。",
    "计划很好，可惜世界没看。",
  ],
  critical: [
    "漂亮，你这下把命都赌对了。",
    "我准备的后手全废了，你赢了。",
    "这种运气，我记账上了。",
    "好，剧本撕了，按你的来。",
    "干净利落，我无话可说。",
    "记住这一刻，以后没这么多。",
  ],
  fumble: [
    "哦。你认真的吗。",
    "我甚至不用添油加醋。",
    "好，这下有意思了。",
    "这把是你自己递给我的。",
    "别解释，我看见了全过程。",
    "我尽量把后果描述得客气一点。",
  ],
  bribe: [
    "他看了看东西，又看了看你。",
    "钱是钱，人是人，他分得很清。",
    "话说到这份上，气氛就变了。",
    "他收手的动作比收钱快。",
    "桌上那点东西，他数了两遍。",
    "他没接，也没推回去。",
  ],
  idle: [
    "时间在走，你们还在原地。",
    "没人说话，只有钟摆的声音。",
    "要不你们商量一下？我等。",
    "安静得有点不像话。",
    "窗外过去一辆车，没停。",
    "我不催，但夜快深了。",
  ],
};

/** 按情绪（mood）组织的通用吐槽池，与 kind 无关。 */
const MOOD_LINES = {
  neutral: [
    "继续，我听着。",
    "你继续，我不插话。",
    "场面还稳，别急。",
    "记录在案，往下走。",
    "先按你说的办。",
    "好，镜头跟着你。",
  ],
  pleased: [
    "这主意我挺喜欢，继续。",
    "嗯，比上一轮聪明多了。",
    "你终于开始像个调查员了。",
    "可以，这一手我认。",
    "总算有点样子了。",
    "好，我给你加点细节。",
  ],
  amused: [
    "你确定？好，我等着看。",
    "有意思，继续往下演。",
    "我就喜欢你们这种自信。",
    "行啊，我陪你玩到底。",
    "这话我记下了，回头算账。",
    "你笑吧，待会儿别哭。",
  ],
  impressed: [
    "这步我没想到，算你厉害。",
    "行，这轮你压着我打。",
    "我认了，你确实看得比我远。",
    "好活，我少说两句。",
    "难得，我给你们放慢镜头。",
    "这一段我会记住的。",
  ],
  skeptical: [
    "我暂且当你认真的。",
    "说下去，我看你怎么圆。",
    "行吧，反正后果是你的。",
    "这理由薄了点，我不买。",
    "你最好想清楚再动手。",
    "我保留意见，你继续。",
  ],
  annoyed: [
    "别磨了，我等得起，NPC 等不起。",
    "这件事你已经问第三遍了。",
    "我再说最后一次。",
    "行，你想耗，我陪你耗。",
    "你的时间不是时间，我的也不是。",
    "快点，别让我替你决定。",
  ],
  ominous: [
    "有些门开了，就不该再关上。",
    "你听见的那声，不是风。",
    "灯灭之前，我劝你记住路。",
    "它一直在看，只是刚才没动。",
    "回头的人，都没能说完那句话。",
    "有些名字念出来，就算打招呼了。",
  ],
  exasperated: [
    "我放弃了，你们随意。",
    "好，那我们从头再来一遍。",
    "这剧本是给你们写的吗？",
    "我尽力了，真的。",
    "随你们，反正存档在。",
    "深呼吸，我们继续，装作没事。",
  ],
};

/** (mood,kind) 交叉池：只写给最出戏的那几种组合。 */
const COMBO_LINES = {
  "amused|fumble": [
    "你笑得出来，我佩服。",
    "这下好了，笑点变成事故。",
    "乐子是你自己找的。",
  ],
  "exasperated|fumble": [
    "我连叹气都懒得叹了。",
    "行，这是第三回了。",
    "你的骰子跟你有仇。",
  ],
  "ominous|critical": [
    "你赢了，可它记住你了。",
    "这一下很漂亮，代价还没到。",
    "灯亮了一瞬，你看见的东西还在。",
  ],
  "impressed|critical": [
    "我备了三条后路，你一条没用。",
    "漂亮得让我有点心疼剧本。",
    "这轮我不挑刺。",
  ],
  "skeptical|open": [
    "你们非要从这儿进，是吧。",
    "我先说清楚，这地方不欢迎人。",
    "行，那我把坏消息提前摆上。",
  ],
  "annoyed|bad": [
    "我早说过，但你没问。",
    "摔了就摔了，别看我。",
    "你自己选的路线。",
  ],
  "amused|bribe": [
    "你拿这个收买人？我笑了。",
    "他收下了，还多问了一句。",
    "价钱开得挺有想象力。",
  ],
  "exasperated|idle": [
    "你们到底走不走？",
    "我在这儿等你们开会。",
    "地图摊开半小时了。",
  ],
  "pleased|good": [
    "这轮干净，赏你一句好话。",
    "干得不错，我不常夸人。",
    "你总算把牌打明白了。",
  ],
  "ominous|fumble": [
    "很好，现在它知道你在哪儿了。",
    "你摔下去的时候，底下有人接住了。",
    "这一跤，摔进别的东西的地盘。",
  ],
  "neutral|critical": [
    "行，运气站在你这边。",
    "干净，继续。",
    "记住了，别指望第二次。",
  ],
  "annoyed|idle": [
    "我不催第三遍。",
    "你们商量，我先喝水。",
    "再不动，天就亮了。",
  ],
};

/** 基调池。未知基调取不到任何东西，于是自动回落通用池。 */
const TONE_LINES = {
  恐怖: [
    "别急，这地方有的是时间。",
    "你听，那声音离近了一点。",
    "灯芯还剩两指宽。",
    "这儿的东西不着急，你也别急。",
    "脚步声停在你身后，但没有呼吸。",
    "有些影子比人先到。",
  ],
  轻松: [
    "来，我们把它当成一次愉快的郊游。",
    "放心，最坏也不过是全员重开。",
    "别紧张，我又不吃人。",
    "这轮我心情好，你们随便折腾。",
    "小场面，稳住。",
    "出事了算我的，可惜不算。",
  ],
  沙雕: [
    "你这一脚踹得很有艺术性。",
    "NPC 表示他很想报警。",
    "骰子表示它尽力了，是手不行。",
    "请把脑洞收一收，地板上都是。",
    "你们这队人凑一起，是命运的恶意。",
    "别怕，我怕就够了。",
  ],
  硬核: [
    "规则怎么写，我们就怎么走。",
    "没有豁免，没有后门，掷骰。",
    "伤就是伤，不会自己好。",
    "你的选择已经在表上了。",
    "我不改数，你也不许。",
    "记好资源，我们按实算。",
  ],
};

/* ==== 吐槽库结束 ==== */

/* ==== 贿赂旁白开始 ==== */

/** 贿赂旁白模板。`{npc}` 与 `{price}` 是占位符，选取后填充。 */
const BRIBE_LINES = {
  granted: [
    "{npc}把东西收了，动作轻得像怕碰坏它。",
    "{npc}看了你一眼，把东西塞进袖子里。",
    "{npc}点点头，没再多问。",
    "{npc}叹了口气，收下了。",
    "{npc}把东西挪到桌下，脸上什么也没有。",
    "{npc}收下之后，说话的口气软了半分。",
  ],
  hagglePrice: [
    "{npc}掂了掂，说 {price} 还不够。",
    "{npc}看了一眼 {price}，摇头。",
    "{npc}要 {price} 再加一点。",
    "{npc}说 {price} 只够买他闭嘴。",
    "{npc}嫌 {price} 太轻，伸出一根手指。",
    "{npc}的视线在 {price} 上停了很久。",
    "{npc}把 {price} 推回来，报了个新数。",
  ],
  hagglePlain: [
    "{npc}摇头，说这不够。",
    "{npc}没接，只是伸出一根手指。",
    "{npc}嫌少，让你再想想。",
    "{npc}盯着你，等你自己加码。",
  ],
  refused: [
    "{npc}把东西推回来，没说话。",
    "{npc}看了你很久，然后笑了。",
    "{npc}说这不是钱的事。",
    "{npc}的手一直没离开桌面。",
    "{npc}摇头，眼神冷了下去。",
    "{npc}拒绝得很客气，也很彻底。",
  ],
  cold: [
    "{npc}连看都没看你手里的东西。",
    "{npc}转身走了，没留一句话。",
    "{npc}只说了一个字：滚。",
    "{npc}从你身边过去，像你不存在。",
    "{npc}把门关上了，很轻。",
    "{npc}叫人过来，把你请出去。",
  ],
};

/** 情绪叠加池：说的是同一场交易，但口吻跟着 GM 的表情走；与 verdict 无关。 */
const BRIBE_MOOD_LINES = {
  amused: [
    "{npc}差点笑出来，又忍住了。",
    "{npc}的嘴角不听话地动了一下。",
    "这场面在他眼里有点好笑。",
  ],
  ominous: [
    "{npc}收下东西时，手一直没抖。",
    "{npc}答应得太快，你该多想一秒。",
    "他背后的影子，比刚才长了一点。",
  ],
  exasperated: [
    "{npc}只想赶紧结束这场对话。",
    "{npc}摆手，让你少说两句。",
    "{npc}连讨价还价的力气都没了。",
  ],
};

/* ==== 贿赂旁白结束 ==== */

/* --------------------------------------------------------------- 内部工具 */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 注入的 rng 必须是函数；否则回落到 Math.random。 */
function resolveRng(value) {
  return typeof value === "function" ? value : Math.random;
}

/**
 * 用 rng() 在 [0,length) 里取一个下标。
 * rng 返回值非法/抛错时按 0 处理，绝不让坏 rng 把模块带崩。
 */
function pickIndex(length, rng) {
  if (length <= 1) return 0;
  let value = Number.NaN;
  try {
    value = Number(rng());
  } catch {
    value = Number.NaN;
  }
  if (!Number.isFinite(value)) value = 0;
  const unit = ((value % 1) + 1) % 1;
  return Math.min(length - 1, Math.floor(unit * length));
}

/** 归一化 recent：只保留字符串，其余忽略。 */
function normalizeRecent(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/** 单行化 + 截断（按码点，避免把代理对切成半个字符）。 */
function cleanField(value, max) {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  const points = [...flat];
  return points.length > max ? points.slice(0, max).join("") : flat;
}

function countChars(value) {
  return [...value].length;
}

function normalizeKind(value) {
  if (typeof value !== "string") return "any";
  const key = value.trim().toLowerCase();
  return KINDS.includes(key) ? key : "any";
}

function toneLines(tone) {
  if (typeof tone !== "string") return [];
  const key = tone.trim();
  if (!TONES.includes(key)) return []; // 未知基调回落通用池，不抛错
  return TONE_LINES[key] || [];
}

/**
 * 某个 (mood,kind,tone) 组合的实际候选池：交叉池 → 基调池 → 时刻池 → 情绪池，去重。
 * 任何组合至少 12 条（时刻 6 + 情绪 6）。
 */
function candidateLines(mood, kind, tone) {
  const pool = [];
  const combo = COMBO_LINES[`${mood}|${kind}`];
  if (combo) pool.push(...combo);
  pool.push(...toneLines(tone));
  pool.push(...(KIND_LINES[kind] || KIND_LINES.any));
  pool.push(...(MOOD_LINES[mood] || MOOD_LINES.neutral));
  return [...new Set(pool)];
}

/** 在候选池里挑一条：先剔掉 recent 用过的；全被用光就回到整池按 rng 任选。 */
function chooseLine(pool, random, recent) {
  const fresh = recent.length ? pool.filter((line) => !recent.includes(line)) : pool;
  const source = fresh.length ? fresh : pool;
  return source[pickIndex(source.length, random)];
}

/* --------------------------------------------------------------- 吐槽 */

/**
 * 一句吐槽。
 * @param {object} [options] { mood?, tone?, turn?, kind?, rng?, recent? }
 * @returns {string} 单行中文，4..40 字
 */
export function snarkLine(options) {
  const opts = isPlainObject(options) ? options : {};
  const mood = normalizeMood(opts.mood);
  const kind = normalizeKind(opts.kind);
  const pool = candidateLines(mood, kind, opts.tone);
  return chooseLine(pool, resolveRng(opts.rng), normalizeRecent(opts.recent));
}

/* --------------------------------------------------------------- 贿赂旁白 */

function normalizeVerdict(value) {
  if (typeof value !== "string") return "refused";
  const key = value.trim().toLowerCase();
  return BRIBE_VERDICTS.includes(key) ? key : "refused";
}

function fillTemplate(template, npc, price) {
  return template.split("{npc}").join(npc).split("{price}").join(price);
}

/**
 * 一句「NPC 对报价的反应」旁白。
 * @param {object} [options] { verdict?, npcName?, offer?, price?, mood?, rng?, recent? }
 * @returns {string} 单行中文，4..60 字
 */
export function bribeLine(options) {
  const opts = isPlainObject(options) ? options : {};
  const verdict = normalizeVerdict(opts.verdict);
  const npc = cleanField(opts.npcName, NPC_MAX) || "对方";
  const price = cleanField(opts.price, PRICE_MAX);
  const mood = normalizeMood(opts.mood);

  let pool;
  if (verdict === "haggle") {
    if (price) {
      // 承诺：haggle 且 price 非空时，句子必须提到 price —— 所以这里只留含 {price} 的模板。
      pool = BRIBE_LINES.hagglePrice.filter((line) => line.includes("{price}"));
    } else {
      pool = [...BRIBE_LINES.hagglePlain];
    }
  } else {
    pool = [...(BRIBE_LINES[verdict] || BRIBE_LINES.refused)];
  }
  const overlay = BRIBE_MOOD_LINES[mood];
  if (overlay) pool.push(...overlay);
  if (verdict === "haggle" && price) pool = pool.filter((line) => line.includes("{price}"));
  pool = [...new Set(pool)];

  // recent 里存的是**填好占位符之后的成品句**，所以去重也要拿成品句比，否则同一模板会被重复选中。
  const recent = normalizeRecent(opts.recent);
  const fill = (template) => fillTemplate(template, npc, price);
  const fresh = recent.length ? pool.filter((template) => !recent.includes(fill(template))) : pool;
  const source = fresh.length ? fresh : pool;
  return fill(source[pickIndex(source.length, resolveRng(opts.rng))]);
}

/* --------------------------------------------------------------- 语气指令 */

/** 吐槽浓度 0..5 各自一段，文案随数值变化（不是开关）。 */
const SNARK_BRIEFS = [
  "0/5 —— 完全不吐槽：禁止吐槽、禁止俏皮话、禁止阴阳怪气，也不要评价玩家的选择；只用平实的中文描述世界与后果。",
  "1/5 —— 几乎不吐槽：默认闭嘴；只在玩家做出明显离谱的选择时，给一句干巴巴的按语，然后立刻回到叙述。",
  "2/5 —— 轻度吐槽：偶尔一句冷幽默就够了，说完就走，别停下来等玩家接梗。",
  "3/5 —— 中度吐槽：每两三轮来一句，可以讽一下局势、NPC 和这个世界的恶意，但别针对玩家本人。",
  "4/5 —— 高频吐槽：几乎每轮都要斜一句，允许阴阳、允许记仇；别让梗压过剧情，关键场面要收得住。",
  "5/5 —— 满级毒舌：每轮都开火，逮到机会就损，可以幸灾乐祸、可以翻旧账；但永远不代替玩家做决定，也永远不替玩家掷骰。",
];

/** 基调对应的叙述取向。 */
const TONE_BRIEFS = {
  恐怖: "本场基调是「恐怖」：压迫感来自具体的细节与未知，不靠音量，也别一次把底牌掀完。",
  轻松: "本场基调是「轻松」：允许玩笑与插科打诨，但别把真正的危机当成儿戏。",
  沙雕: "本场基调是「沙雕」：荒诞可以，逻辑崩坏不行；笑点要服务场面，而不是拆台。",
  硬核: "本场基调是「硬核」：规则从严执行，代价照算，不因为玩家撒娇就改数。",
};

/** 吐槽浓度：只接受真正的数字或非空数字字符串，其余回落默认值（`Number(null)===0` 是坑）。 */
function clampSnark(value) {
  let numeric = Number.NaN;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && value.trim() !== "") numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SNARK;
  const rounded = Math.round(numeric);
  if (rounded < 0) return 0;
  if (rounded > 5) return 5;
  return rounded;
}

/**
 * 注入 system prompt 的语气指令段。
 * @param {object} [options] { tone?, snark?, pcName? }
 * @returns {string} 多行中文指令
 */
export function styleBrief(options) {
  const opts = isPlainObject(options) ? options : {};
  const snark = clampSnark(opts.snark);
  const tone = typeof opts.tone === "string" ? opts.tone.trim() : "";
  const toneBrief = TONE_BRIEFS[tone] || "基调未指定：按剧本自然推进，在恐怖与轻松之间自己找平衡。";
  const pcName = cleanField(opts.pcName, 60) || "玩家的调查员";
  return [
    "【GM 人格】你是本场跑团的 GM，负责描述世界、扮演 NPC、执行规则，而不是当玩家的提示器或代办。",
    `【吐槽浓度】${SNARK_BRIEFS[snark]}`,
    "【拟人】有情绪、会不耐烦、会得意、会记仇：被耍了就摆脸色，被打脸了就认，被惊艳到就夸一句。闹脾气可以，说教不行。",
    "【边界】不代替玩家行动，不代替玩家掷骰，不替玩家做决定，也不把线索的答案直接递过去；玩家做什么，你只负责描述世界如何回应。",
    "【先演后判】先给可感知的细节——声音、气味、光线、触感、温度——再给结论；别用「气氛诡异」这种空话糊弄。",
    "【叙述】具体、克制、有取舍；坏消息要说清楚，但不必替玩家算出最优解。",
    `【基调】${toneBrief}`,
    `【玩家角色】${pcName}。指名道姓地叫 TA，别用「你们」糊过去。`,
  ].join("\n");
}

/**
 * 注入 system prompt 的指令语法说明。与 parseDirectives 的容忍范围保持一致。
 * @returns {string} 多行中文说明
 */
export function directiveGuide() {
  return [
    "【让宿主做事：指令语法】",
    "你不能掷骰、不能改存档、不能自己加数值。需要这些时，在回复里写一条指令，宿主会照做并把结果作为线报插回对话。",
    "1. <<roll 1d100 dc=55 理由>> —— 让宿主掷骰；dc 可省略（<<roll 3d6>>），理由也可以省略，但写清楚为什么掷。",
    `2. <<mood amused>> —— 切换 GM 表情，取值：${MOODS.join(" / ")}。`,
    "3. <<bribe granted price=一瓶威士忌 suspicion=+1>> —— 贿赂判定；verdict 取 granted / haggle / refused / cold，price 与 suspicion 可省略。",
    "规则：指令可以混用全角《《》》与半角<<>>，大小写不敏感，括号内外多余空格无所谓；无法识别的指令会被宿主丢掉，绝不会显示给玩家。",
    "指令之外的正文才是给玩家看的内容：不要在正文里复述这些括号，也不要向玩家解释这套语法。",
  ].join("\n");
}

/* --------------------------------------------------------------- 指令解析 */

/** 指令开/闭括号各有半角与全角两种写法，且允许混用。 */
const OPENERS = ["<<", "《《"];
const CLOSERS = [">>", "》》"];

function firstIndexOf(source, needles, from) {
  let found = -1;
  for (const needle of needles) {
    const at = source.indexOf(needle, from);
    if (at >= 0 && (found < 0 || at < found)) found = at;
  }
  return found;
}

/**
 * 扫出全部 <<…>> / 《《…》》 片段。
 * 没闭合的 `<<` 也算一段（一直吃到结尾）——这样正文里绝不会残留 `<<`。
 */
function scanSpans(source) {
  const spans = [];
  let index = 0;
  while (index < source.length) {
    const open = firstIndexOf(source, OPENERS, index);
    if (open < 0) break;
    const contentStart = open + 2; // 两种开括号都是 2 个字符
    const close = firstIndexOf(source, CLOSERS, contentStart);
    const contentEnd = close < 0 ? source.length : close;
    const end = close < 0 ? source.length : close + 2;
    spans.push({
      start: open,
      end,
      closed: close >= 0,
      raw: source.slice(open, end),
      content: source.slice(contentStart, contentEnd),
    });
    index = end;
  }
  return spans;
}

/** 去掉首尾空白、把内部连续空行压成一个空行。 */
function tidyText(value) {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .trim();
}

/** 读 `name=value` 形式的选项值；支持全角等号与可选的引号。 */
function readOption(content, name) {
  const re = new RegExp(`${name}\\s*[=＝]\\s*(["']?)([^\\s"']+)\\1`, "i");
  const match = re.exec(content);
  return match ? match[2] : "";
}

/** 收集理由：跳过被识别为选项的 token（如 dc=55 / price=…）。 */
function collectReason(tokens, from, excluded) {
  const kept = [];
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    const match = /^([A-Za-z_]+)\s*[=＝]/.exec(token);
    if (match && excluded.includes(match[1].toLowerCase())) continue;
    kept.push(token);
  }
  return kept.join(" ");
}

function readRoll(span, tokens) {
  const formula = typeof tokens[1] === "string" ? tokens[1].trim() : "";
  if (!formula || /^[A-Za-z_]+\s*[=＝]/.test(formula)) return null; // 没有公式就没法掷
  const rawDc = readOption(span.content, "dc").replace(/[,，;；。]+$/, "");
  const numeric = rawDc === "" ? Number.NaN : Number(rawDc);
  return {
    formula,
    dc: Number.isFinite(numeric) ? numeric : null,
    reason: collectReason(tokens, 2, ["dc"]),
    raw: span.raw,
  };
}

function readBribe(span, tokens) {
  const verdict = normalizeVerdict(tokens[1]);
  const rawSuspicion = readOption(span.content, "suspicion");
  let suspicion = 0;
  if (rawSuspicion) {
    const parsed = Number.parseInt(rawSuspicion.replace(/[^\d+-]/g, ""), 10);
    suspicion = Number.isFinite(parsed) ? parsed : 0;
  }
  return {
    verdict,
    price: readOption(span.content, "price"),
    suspicion,
    reason: collectReason(tokens, 2, ["price", "suspicion"]),
    raw: span.raw,
  };
}

function applyDirective(span, result) {
  // 没闭合的 `<<` 一律不算指令：它可能是模型话说到一半，不该被当成掷骰/揭密执行。
  if (!span.closed) {
    result.ignored.push(span.raw);
    return;
  }

  const tokens = span.content.trim().split(/\s+/).filter(Boolean);
  const name = tokens.length ? tokens[0].toLowerCase() : "";

  if (name === "roll") {
    const entry = readRoll(span, tokens);
    if (entry) result.rolls.push(entry);
    else result.ignored.push(span.raw);
    return;
  }

  if (name === "mood") {
    const value = typeof tokens[1] === "string" ? tokens[1].trim().toLowerCase() : "";
    if (MOODS.includes(value)) {
      result.moods.push(value);
      result.mood = value;
    } else {
      // 最后一个 mood 指令非法 → mood 归 null，原文进 ignored
      result.mood = null;
      result.ignored.push(span.raw);
    }
    return;
  }

  if (name === "bribe") {
    result.bribes.push(readBribe(span, tokens));
    return;
  }

  result.ignored.push(span.raw);
}

function emptyDirectives() {
  return { text: "", mood: null, moods: [], rolls: [], bribes: [], ignored: [] };
}

/**
 * 拆出模型回复里的全部指令，并交出干净正文。
 * 非字符串输入返回空结构且不抛错；返回的 text 绝不残留 `<<` / `《《`。
 * @param {unknown} text
 * @returns {{text: string, mood: string|null, moods: string[], rolls: Array<object>, bribes: Array<object>, ignored: string[]}}
 */
export function parseDirectives(text) {
  if (typeof text !== "string") return emptyDirectives();

  const spans = scanSpans(text);
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(text.slice(cursor, span.start));
    cursor = span.end;
  }
  pieces.push(text.slice(cursor));

  const result = emptyDirectives();
  result.text = tidyText(pieces.join(""));
  for (const span of spans) applyDirective(span, result);
  return result;
}
