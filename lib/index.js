/**
 * dsh-trpg — 宿主半。
 *
 * 已安装 bundle 的浏览器半拿不到宿主 Service（它的 factory 只收到 `require`），所以跑团需要
 * 的一切都走这里注册的路由：
 *
 *   GET  /api/dsh-trpg/state        整份轻档 + 派生视图
 *   POST /api/dsh-trpg/command      应用一个命令，落盘，回状态
 *   GET  /api/dsh-trpg/models       harness 的 provider/model 目录
 *   POST /api/dsh-trpg/scenario     剧本：list / read / search / import
 *   POST /api/dsh-trpg/turn         一个回合，SSE 流式回 GM 叙述
 *   POST /api/dsh-trpg/bribe        贿赂谈判，SSE 流式回 NPC 反应 + 判定
 *   POST /api/dsh-trpg/import       整档替换
 *
 * 骰子一律由**宿主**掷（dice.js），模型只能通过 `<<roll …>>` 请求掷骰 —— 它永远拿不到随机数，
 * 也就无法伪造骰点。
 */

import { randomUUID } from "node:crypto";

import { evaluateOffer } from "./bribe.js";
import { applyCommand, CommandError } from "./commands.js";
import { cryptoRng, rollCheck, rollFormula } from "./dice.js";
import { bribeLine, directiveGuide, moodEmoji, normalizeMood, parseDirectives, snarkLine, styleBrief } from "./gm.js";
import { bribePrompt, buildMessages, buildSystemPrompt } from "./prompt.js";
import { ScenarioError, emptyScenario, parseScenario, readSection, scenarioDigest, searchSections } from "./scenario.js";
import { SchemaError } from "./schema.js";
import { StoreError, TrpgStore } from "./store.js";
import { buildView } from "./view.js";

export const name = "dsh-trpg";

/** 路径必须落在 `/api` 之下 —— connection 服务会断言这一点。 */
export const ROUTES = {
  state: "/api/dsh-trpg/state",
  command: "/api/dsh-trpg/command",
  models: "/api/dsh-trpg/models",
  scenario: "/api/dsh-trpg/scenario",
  turn: "/api/dsh-trpg/turn",
  bribe: "/api/dsh-trpg/bribe",
  import: "/api/dsh-trpg/import",
};

const json = (value) => Response.json(value, { headers: { "cache-control": "no-store" } });
const ok = (value) => json({ ok: true, ...value });
const fail = (code, message, status = 200) => json({ ok: false, error: { code, message } }, status);

function fetchRouteRegistrar(connection) {
  return typeof connection?.fetch?.register === "function" ? connection.fetch.register.bind(connection.fetch) : undefined;
}

export function apply(ctx, config = {}) {
  const store = new TrpgStore({ env: config.env ?? process.env });
  // 启动时就加载：坏档在启动期被隔离留证，`/state` 于是成为纯读。
  store.load();

  const idFactory = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const commandCtx = {
    id: idFactory,
    now: () => Date.now(),
    roll: ({ formula, dc, reason }) => ({ ...rollFormula(formula, cryptoRng), dc: dc ?? null, reason: reason ? String(reason) : "" }),
    check: (options) => rollCheck(options, cryptoRng),
  };

  // 剧本正文可能几百 KB，别让每条命令都去读盘；导入与删档时失效。
  const scenarioCache = new Map();
  const scenarioFor = (campaignId) => {
    if (!campaignId) return emptyScenario();
    if (!scenarioCache.has(campaignId)) scenarioCache.set(campaignId, store.readScenario(campaignId));
    return scenarioCache.get(campaignId);
  };
  const invalidateScenario = (campaignId) => scenarioCache.delete(campaignId);

  const viewOf = (state, extra = {}) => {
    const campaignId = extra.campaignId || state.activeCampaignId;
    return buildView(state, { campaignId, moodEmoji, scenario: scenarioFor(campaignId), ...extra });
  };
  const okState = (state, extra = {}) => ok({ state, view: viewOf(state, extra), ...extra });

  function resolveSelection(requested) {
    const wanted = requested && requested.model ? requested : store.state.settings.model;
    if (wanted && wanted.model) return wanted;
    const fallback = ctx.get("agentDefaultModel")?.currentSelection?.() ?? null;
    return fallback && fallback.model ? fallback : null;
  }

  ctx.inject(["connection"], (c) => {
    const register = fetchRouteRegistrar(c.get("connection"));
    if (!register) {
      ctx.logger?.warn?.("dsh-trpg: connection 服务没有暴露 fetch registrar，路由未挂载");
      return;
    }
    // 每条路由都必须显式声明 requestBody 模式：共享 Fetch handler 读 `route.requestBody`，
    // 未声明时回落到 streaming，于是无 body 的 GET 会被构造成带 body 的 Request 并抛
    // `Request with GET/HEAD method cannot have body`，handler 根本不跑，浏览器拿到空响应。
    const mount = (route, label) => c.effect(() => register({ requestBody: "buffered", ...route }), `dsh-trpg: ${label}`);

    /* -------------------------------------------------------------- state --- */

    mount(
      {
        path: ROUTES.state,
        methods: ["GET"],
        fetch: () => {
          const state = store.ensure();
          return okState(state, { lastLoadError: store.lastLoadError ? String(store.lastLoadError.message ?? store.lastLoadError) : null });
        },
      },
      "state route",
    );

    /* ------------------------------------------------------------ command --- */

    mount(
      {
        path: ROUTES.command,
        methods: ["POST"],
        fetch: async (request) => {
          let command;
          try {
            command = await request.json();
          } catch {
            return fail("BAD_JSON", "请求体不是合法 JSON");
          }
          try {
            const result = store.mutate((state) => applyCommand(state, command, commandCtx));
            const dropped = result && result.result && result.result.dropScenario;
            if (dropped) invalidateScenario(dropped);
            return okState(store.state, { result });
          } catch (error) {
            if (error instanceof CommandError || error instanceof SchemaError || error instanceof StoreError) {
              return fail(error.code, error.message);
            }
            return fail("COMMAND_FAILED", String(error?.message ?? error));
          }
        },
      },
      "command route",
    );

    /* ------------------------------------------------------------- models --- */

    mount(
      {
        path: ROUTES.models,
        methods: ["GET"],
        fetch: async () => {
          const llm = ctx.get("llm");
          if (!llm) return fail("NO_LLM", "当前环境没有可用的模型服务（llm）");
          let providers = [];
          try {
            providers = llm.listProviders();
          } catch (error) {
            return fail("LIST_FAILED", String(error?.message ?? error));
          }
          const models = [];
          for (const provider of providers ?? []) {
            let list = [];
            try {
              list = await llm.listModels(provider.id);
            } catch (error) {
              // 某个 provider 没配置凭据不该把其它 provider 一起藏起来。
              list = [];
              ctx.logger?.debug?.(`dsh-trpg: listModels(${provider.id}) failed: ${error}`);
            }
            for (const model of list ?? []) {
              models.push({
                provider: provider.id,
                providerName: provider.name ?? provider.id,
                id: model.id,
                name: model.name ?? model.id,
                description: model.description ?? "",
              });
            }
          }
          const fallback = ctx.get("agentDefaultModel")?.currentSelection?.() ?? null;
          return ok({ providers, models, fallback });
        },
      },
      "models route",
    );

    /* ----------------------------------------------------------- scenario --- */

    mount(
      {
        path: ROUTES.scenario,
        methods: ["POST"],
        fetch: async (request) => {
          let body;
          try {
            body = await request.json();
          } catch {
            return fail("BAD_JSON", "请求体不是合法 JSON");
          }
          const state = store.ensure();
          const campaignId = body.campaignId || state.activeCampaignId;
          if (!campaignId) return fail("NO_ACTIVE_CAMPAIGN", "先开一个战役");
          const action = typeof body.action === "string" ? body.action : "list";

          try {
            if (action === "import") {
              const doc = parseScenario(body.source, { title: body.title, now: Date.now() });
              store.writeScenario(campaignId, doc);
              invalidateScenario(campaignId);
              return okState(store.state, {
                campaignId,
                scenario: { title: doc.title, sectionCount: doc.sections.length, headings: doc.sections.map((s) => ({ id: s.id, heading: s.heading, level: s.level })) },
                digest: scenarioDigest(doc),
              });
            }

            const doc = scenarioFor(campaignId);
            if (action === "read") {
              if (!body.sectionId) {
                return ok({
                  scenario: { title: doc.title, sections: doc.sections.map(({ id, heading, level, chars }) => ({ id, heading, level, chars })) },
                  digest: scenarioDigest(doc),
                });
              }
              const section = readSection(doc, body.sectionId);
              if (!section) return fail("SECTION_NOT_FOUND", `找不到剧本节 ${body.sectionId}`);
              return ok({ scenario: { title: doc.title }, section });
            }
            if (action === "search") {
              const query = typeof body.query === "string" ? body.query : "";
              const found = searchSections(doc, query, { limit: body.limit });
              return ok({ scenario: { title: doc.title }, query, ...found });
            }
            return ok({
              scenario: { title: doc.title, sections: doc.sections.map(({ id, heading, level, chars }) => ({ id, heading, level, chars })) },
              digest: scenarioDigest(doc),
            });
          } catch (error) {
            if (error instanceof ScenarioError) return fail(error.code, error.message);
            return fail("SCENARIO_FAILED", String(error?.message ?? error));
          }
        },
      },
      "scenario route",
    );

    /* -------------------------------------------------------------- turns --- */

    mount(
      {
        path: ROUTES.turn,
        methods: ["POST"],
        fetch: async (request) => {
          let body;
          try {
            body = await request.json();
          } catch {
            return fail("BAD_JSON", "请求体不是合法 JSON");
          }
          const llm = ctx.get("llm");
          if (!llm) return fail("NO_LLM", "当前环境没有可用的模型服务（llm）");

          const state = store.ensure();
          const campaignId = body.campaignId || state.activeCampaignId;
          const campaign = state.campaigns.find((entry) => entry.id === campaignId);
          if (!campaign) return fail("CAMPAIGN_NOT_FOUND", "先开一个战役");

          const selection = resolveSelection(body.model);
          if (!selection) return fail("NO_MODEL", "没有选择模型，也没有可用的默认模型");

          const content = typeof body.content === "string" ? body.content.trim() : "";
          if (!content) return fail("BAD_TEXT", "说点什么再发");

          // 玩家发言先落盘：模型调用失败也不能把玩家说的话弄丢。
          try {
            store.mutate((live) => {
              applyCommand(live, { type: "log.append", campaignId, role: "player", text: content }, commandCtx);
              applyCommand(live, { type: "turn.bump", campaignId }, commandCtx);
            });
          } catch (error) {
            return fail(error?.code ?? "COMMAND_FAILED", String(error?.message ?? error));
          }

          const live = store.ensure();
          const liveCampaign = live.campaigns.find((entry) => entry.id === campaignId);
          const log = live.log.filter((entry) => entry.campaignId === campaignId);
          const digest = scenarioDigest(scenarioFor(campaignId), { maxChars: 1600 });
          const system = buildSystemPrompt({
            campaign: liveCampaign,
            digest,
            style: styleBrief({ tone: liveCampaign.tone, snark: live.settings.snark, pcName: liveCampaign.pcName }),
            guide: directiveGuide(),
            extra: liveCampaign.clues.some((clue) => !clue.found)
              ? "【提醒】现场还有玩家没发现的线索。玩家明确搜查时要让他过检定，别直接白给。"
              : "",
          });
          const messages = buildMessages({
            campaign: liveCampaign,
            log,
            playerText: content,
            provider: selection.provider,
            model: selection.model,
            maxChars: live.settings.maxContextChars,
          });

          return sseResponse(async (send) => {
            let text = "";
            let status = "done";
            let failure = null;
            try {
              for await (const chunk of llm.stream({
                provider: selection.provider,
                model: selection.model,
                messages,
                ...(system ? { system } : {}),
                signal: request.signal,
              })) {
                if (chunk?.type === "text-delta" && chunk.text) {
                  text += chunk.text;
                  send({ type: "delta", text: chunk.text });
                } else if (chunk?.type === "finish") {
                  const reason = chunk.reason ?? {};
                  if (reason.kind === "error") {
                    status = "error";
                    failure = reason.failure ?? { message: "模型调用失败" };
                  } else if (reason.kind === "aborted") {
                    status = "aborted";
                  }
                }
              }
            } catch (error) {
              status = request.signal?.aborted ? "aborted" : "error";
              failure = { message: String(error?.message ?? error), code: error?.code ?? "STREAM_FAILED" };
            }

            const directives = parseDirectives(text);
            const events = [];
            let snark = null;
            try {
              store.mutate((doc) => {
                const turnCampaign = doc.campaigns.find((entry) => entry.id === campaignId);
                if (!turnCampaign) return;
                if (directives.mood) {
                  applyCommand(doc, { type: "scene.set", campaignId, mood: directives.mood }, commandCtx);
                  send({ type: "mood", mood: directives.mood, emoji: moodEmoji(directives.mood) });
                }
                for (const roll of directives.rolls) {
                  try {
                    const applied = applyCommand(
                      doc,
                      { type: "dice.roll", campaignId, formula: roll.formula, dc: roll.dc, reason: roll.reason },
                      commandCtx,
                    );
                    const event = { type: "roll", ...applied.result.roll };
                    events.push(event);
                    send(event);
                  } catch (error) {
                    // 模型给了个非法公式：告诉界面，但绝不因此毁掉整个回合。
                    send({ type: "roll-error", formula: roll.formula, message: String(error?.message ?? error) });
                  }
                }
                for (const directive of directives.bribes) {
                  const open = turnCampaign.bribes.find((entry) => entry.status === "open");
                  if (!open) continue;
                  try {
                    applyCommand(
                      doc,
                      {
                        type: "bribe.settle",
                        campaignId,
                        bribeId: open.id,
                        status: directive.verdict,
                        price: directive.price,
                        suspicionDelta: directive.suspicion,
                        reveal: directive.verdict === "granted",
                      },
                      commandCtx,
                    );
                  } catch {
                    /* 判定失败不影响叙述 */
                  }
                }

                if (directives.text.trim() || text.trim()) {
                  applyCommand(
                    doc,
                    {
                      type: "log.append",
                      campaignId,
                      role: "gm",
                      text: directives.text || text,
                      meta: { mood: directives.mood, model: selection.model },
                    },
                    commandCtx,
                  );
                }

                const fumble = events.some((event) => event.level === "fumble" || event.level === "critical");
                const kind = fumble
                  ? "fumble"
                  : directives.bribes.some((entry) => entry.verdict === "refused")
                    ? "bribe"
                    : events.length
                      ? "good"
                      : content.length < 6
                        ? "idle"
                        : "open";
                if (doc.settings.snark >= 2 || kind === "fumble") {
                  const recent = doc.log
                    .filter((entry) => entry.campaignId === campaignId && entry.meta && entry.meta.kind === "snark")
                    .slice(-8)
                    .map((entry) => entry.text);
                  const line = snarkLine({ mood: turnCampaign.scene.mood, tone: turnCampaign.tone, turn: turnCampaign.turn, kind, recent });
                  if (line) {
                    const entry = applyCommand(
                      doc,
                      { type: "log.append", campaignId, role: "gm", text: line, meta: { kind: "snark", mood: turnCampaign.scene.mood } },
                      commandCtx,
                    );
                    snark = entry.result.entry;
                    send({ type: "snark", text: line, entry: snark });
                  }
                }
              });
            } catch (error) {
              ctx.logger?.warn?.(`dsh-trpg: 回合善后失败 ${error}`);
            }

            const finalState = store.ensure();
            if (status === "error") {
              send({ type: "error", code: failure?.code ?? "STREAM_FAILED", message: failure?.message ?? "模型调用失败", content: text });
            } else {
              send({ type: "done", status, content: directives.text || text, view: viewOf(finalState, { campaignId }) });
            }
          });
        },
      },
      "turn route",
    );

    /* ------------------------------------------------------------- bribe --- */

    mount(
      {
        path: ROUTES.bribe,
        methods: ["POST"],
        fetch: async (request) => {
          let body;
          try {
            body = await request.json();
          } catch {
            return fail("BAD_JSON", "请求体不是合法 JSON");
          }
          const llm = ctx.get("llm");
          if (!llm) return fail("NO_LLM", "当前环境没有可用的模型服务（llm）");

          const state = store.ensure();
          const campaignId = body.campaignId || state.activeCampaignId;
          let campaign = state.campaigns.find((entry) => entry.id === campaignId);
          if (!campaign) return fail("CAMPAIGN_NOT_FOUND", "先开一个战役");

          const offer = typeof body.offer === "string" ? body.offer.trim() : "";
          if (!offer) return fail("BAD_TEXT", "先说说你打算拿什么换");

          const selection = resolveSelection(body.model);
          if (!selection) return fail("NO_MODEL", "没有选择模型，也没有可用的默认模型");

          let bribe = campaign.bribes.find((entry) => entry.id === body.bribeId);
          if (!bribe) {
            try {
              const opened = store.mutate((live) =>
                applyCommand(
                  live,
                  { type: "bribe.open", campaignId, npcName: body.npcName, want: body.want, secret: body.secret, attitude: body.attitude },
                  commandCtx,
                ),
              );
              bribe = opened.result.bribe;
            } catch (error) {
              return fail(error?.code ?? "BRIBE_FAILED", String(error?.message ?? error));
            }
          }
          if (bribe.status === "cold" || bribe.status === "granted") {
            return fail("BRIBE_CLOSED", bribe.status === "cold" ? "这人已经不肯再听你说话了" : "这笔交易已经成交了");
          }

          campaign = store.ensure().campaigns.find((entry) => entry.id === campaignId);
          bribe = campaign.bribes.find((entry) => entry.id === bribe.id);
          const npc = campaign.npcs.find((entry) => entry.id === bribe.npcId) || null;
          const log = store.ensure().log.filter((entry) => entry.campaignId === campaignId);
          const system = buildSystemPrompt({
            campaign,
            digest: scenarioDigest(scenarioFor(campaignId), { maxChars: 900 }),
            style: styleBrief({ tone: campaign.tone, snark: store.state.settings.snark, pcName: campaign.pcName }),
            guide: directiveGuide(),
          });
          const messages = buildMessages({
            campaign,
            log: log.slice(-10),
            playerText: bribePrompt({ campaign, bribe, npc, offer }),
            provider: selection.provider,
            model: selection.model,
            maxChars: Math.min(6000, store.state.settings.maxContextChars),
          });

          return sseResponse(async (send) => {
            let text = "";
            let status = "done";
            let failure = null;
            try {
              for await (const chunk of llm.stream({
                provider: selection.provider,
                model: selection.model,
                messages,
                ...(system ? { system } : {}),
                signal: request.signal,
              })) {
                if (chunk?.type === "text-delta" && chunk.text) {
                  text += chunk.text;
                  send({ type: "delta", text: chunk.text });
                } else if (chunk?.type === "finish") {
                  const reason = chunk.reason ?? {};
                  if (reason.kind === "error") {
                    status = "error";
                    failure = reason.failure ?? { message: "模型调用失败" };
                  } else if (reason.kind === "aborted") {
                    status = "aborted";
                  }
                }
              }
            } catch (error) {
              status = request.signal?.aborted ? "aborted" : "error";
              failure = { message: String(error?.message ?? error), code: error?.code ?? "STREAM_FAILED" };
            }

            const directives = parseDirectives(text);
            const mechanical = evaluateOffer({ bribe, npc, offer });
            const directive = directives.bribes[directives.bribes.length - 1] || null;
            // 注意：不管走哪条路，下面都会把 verdict 显式传给 bribe.offer，所以命令层
            // 一定回 mechanical:false。界面上要显示「这条判定是谁定的」，得在这里自己记。
            const settlement = directive
              ? { verdict: directive.verdict, price: directive.price, suspicionDelta: directive.suspicion }
              : { verdict: mechanical.verdict, price: mechanical.price, suspicionDelta: mechanical.suspicionDelta };

            let outcome = null;
            try {
              const applied = store.mutate((doc) => {
                const result = applyCommand(
                  doc,
                  {
                    type: "bribe.offer",
                    campaignId,
                    bribeId: bribe.id,
                    text: offer,
                    verdict: settlement.verdict,
                    price: settlement.price,
                    suspicionDelta: settlement.suspicionDelta,
                  },
                  commandCtx,
                );
                const voiced = directives.text.trim() || bribeLine({ verdict: result.result.verdict, npcName: bribe.npcName, offer, price: settlement.price, mood: campaign.scene.mood });
                applyCommand(doc, { type: "log.append", campaignId, role: "gm", text: voiced, meta: { kind: "bribe", verdict: result.result.verdict, bribeId: bribe.id } }, commandCtx);
                return result.result;
              });
              outcome = applied;
            } catch (error) {
              return send({ type: "error", code: error?.code ?? "BRIBE_FAILED", message: String(error?.message ?? error) });
            }

            send({
              type: "verdict",
              verdict: outcome.verdict,
              reason: outcome.reason,
              // 模型没给 <<bribe>> 时是规则算的，这时才叫「机械兜底」。
              mechanical: !directive,
              revealed: outcome.revealed,
              bribe: outcome.bribe,
            });
            const finalState = store.ensure();
            if (status === "error") {
              send({ type: "error", code: failure?.code ?? "STREAM_FAILED", message: failure?.message ?? "模型调用失败", content: text });
            } else {
              send({ type: "done", status, content: directives.text || text, view: viewOf(finalState, { campaignId }) });
            }
          });
        },
      },
      "bribe route",
    );

    /* ------------------------------------------------------------ import --- */

    mount(
      {
        path: ROUTES.import,
        methods: ["POST"],
        fetch: async (request) => {
          let document;
          try {
            document = await request.json();
          } catch {
            return fail("BAD_JSON", "请求体不是合法 JSON");
          }
          try {
            const state = store.replace(document);
            scenarioCache.clear();
            return okState(state);
          } catch (error) {
            if (error instanceof SchemaError) return fail(error.code, error.message);
            return fail("IMPORT_FAILED", String(error?.message ?? error));
          }
        },
      },
      "import route",
    );
  });
}

function sseResponse(producer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        await producer(send);
      } catch (error) {
        send({ type: "error", code: "STREAM_FAILED", message: String(error?.message ?? error) });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 客户端已中止 */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export { sseResponse };
