/**
 * dsh-trpg — 浏览器半（client half）。
 *
 * 已安装 bundle 的 factory 只收到 `require`，拿不到宿主 Service，所以这里只用普通 fetch
 * 打插件自己的七条 HTTP 路由（见 lib/index.js 的 ROUTES）。没有打包器：本文件是 plain
 * IIFE，元素一律 React.createElement，从不 JSX、从不顶层 import。
 *
 * 界面消费的永远是宿主算好的 `view`（lib/view.js 的 buildView 产物）：百分比、态度标签、
 * 能不能继续报价、场外音该不该出现，全都不在这里重算。
 */
window.__ModuleLoader__.load({
	id: "dsh-trpg",
	factory: (require) => {
		"use strict";

		const React = require("react");
		const h = React.createElement;

		const PLUGIN_ID = "dsh-trpg";
		/** 侧栏图标与 main 面板共用一个 id：图标把面板调出来，keyed main 全屏渲染它。 */
		const PANEL_ID = "dsh-trpg";

		/** 宿主注册的七条路由，一条不多一条不少（scripts/check.mjs 反向校验）。 */
		const API = {
			state: "/api/dsh-trpg/state",
			command: "/api/dsh-trpg/command",
			models: "/api/dsh-trpg/models",
			scenario: "/api/dsh-trpg/scenario",
			turn: "/api/dsh-trpg/turn",
			bribe: "/api/dsh-trpg/bribe",
			import: "/api/dsh-trpg/import",
		};

		const SNARK_MAX = 5;
		const CONTEXT_LIMITS = { min: 2000, max: 200000, fallback: 12000 };
		const QUICK_FORMULAS = ["d100", "1d6", "2d6+1"];
		const DIFFICULTIES = [
			{ value: "regular", label: "常规" },
			{ value: "hard", label: "困难" },
			{ value: "extreme", label: "极难" },
		];
		const BRIBE_STATUS_LABELS = { open: "谈判中", granted: "成交", refused: "拒绝", cold: "冷淡" };
		const VERDICT_LABELS = { granted: "成交", haggle: "讨价还价", refused: "拒绝", cold: "不再谈" };

		/* ------------------------------------------------------------ styles -- */

		/*
		 * Fills only. `--dsw-alias-brand-primary` is an INK token (light #0f1115,
		 * dark #f9fafb), so painting it behind label text is invisible in one of
		 * the two themes. Primary buttons therefore pair
		 * `--dsw-alias-button-primary-fill` with `--dsw-alias-label-primary-foreground`;
		 * the ink token stays on borders and focus rings only.
		 */
		const CSS = `
.dsh-trpg { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-trpg * { box-sizing: border-box; }
.dsh-trpg__bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; padding-top: calc(8px + var(--dsh-frame-top-clearance, 0px)); border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dsh-trpg__title { font-weight: 600; font-size: 14px; }
.dsh-trpg__spacer { flex: 1; }
.dsh-trpg__badge { padding: 1px 6px; border-radius: 999px; font-size: 10.5px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-trpg__btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; line-height: 18px; white-space: nowrap; }
.dsh-trpg__btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-trpg__btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-trpg__btn--primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-trpg__btn--on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-trpg__btn--danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-trpg__input, .dsh-trpg__select, .dsh-trpg__textarea { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-trpg__input:focus, .dsh-trpg__select:focus, .dsh-trpg__textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-trpg__textarea { resize: vertical; min-height: 56px; width: 100%; }
.dsh-trpg__textarea--tall { min-height: 130px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dsh-trpg__error { margin: 8px 12px 0; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsh-trpg__notice { margin: 8px 12px 0; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-trpg__body { display: flex; flex: 1; min-height: 0; gap: 10px; padding: 10px 12px 12px; }
.dsh-trpg__col { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
.dsh-trpg__col--left { width: 264px; flex: none; }
.dsh-trpg__col--center { flex: 1; min-width: 0; overflow: hidden; }
.dsh-trpg__col--right { width: 328px; flex: none; }
.dsh-trpg__card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
.dsh-trpg__card-head { display: flex; align-items: center; gap: 6px; }
.dsh-trpg__card-title { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-trpg__list { display: flex; flex-direction: column; gap: 3px; max-height: 190px; overflow: auto; }
.dsh-trpg__item { display: block; width: 100%; text-align: left; padding: 5px 8px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.dsh-trpg__item:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-trpg__item--active { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsh-trpg__item small { display: block; color: var(--dsw-alias-label-secondary); font-size: 10.5px; margin-top: 1px; }
.dsh-trpg__row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-trpg__row .dsh-trpg__input { flex: 1; min-width: 80px; }
.dsh-trpg__form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.dsh-trpg__details > summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-trpg__hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dsh-trpg__rows { display: flex; flex-direction: column; gap: 6px; }
.dsh-trpg__stat-label { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; margin-bottom: 3px; }
.dsh-trpg__stat-label span:last-child { color: var(--dsw-alias-label-secondary); }
.dsh-trpg__bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsh-trpg__bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-button-primary-fill); }
.dsh-trpg__bar-fill--clock { background: var(--dsw-alias-state-warn-primary); }
.dsh-trpg__tags { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-trpg__tag { padding: 1px 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); font-size: 10.5px; }
.dsh-trpg__tag--flag { border-style: dashed; color: var(--dsw-alias-label-secondary); }
.dsh-trpg__clue { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }
.dsh-trpg__clue--found { color: var(--dsw-alias-label-primary); }
.dsh-trpg__log { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsh-trpg__msg { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 9px; background: var(--dsw-alias-bg-layer-2); }
.dsh-trpg__msg--player { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); margin-left: 36px; }
.dsh-trpg__msg--system { border-style: dashed; }
.dsh-trpg__msg-role { font-size: 10.5px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.dsh-trpg__msg-body { white-space: pre-wrap; word-break: break-word; line-height: 1.55; font-size: 12.5px; }
.dsh-trpg__snark { font-style: italic; font-size: 11px; color: var(--dsw-alias-label-secondary); padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l1); }
.dsh-trpg__dice { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11.5px; }
.dsh-trpg__chip { padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
.dsh-trpg__chip-total { font-weight: 700; font-size: 13px; }
.dsh-trpg__dice-text { color: var(--dsw-alias-label-secondary); }
.dsh-trpg__cursor { display: inline-block; width: 6px; height: 13px; background: var(--dsw-alias-brand-primary); vertical-align: text-bottom; animation: dsh-trpg-blink 1s steps(2) infinite; }
@keyframes dsh-trpg-blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }
.dsh-trpg__suggestions { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-trpg__composer { display: flex; flex-direction: column; gap: 6px; }
.dsh-trpg__composer-row { display: flex; align-items: center; gap: 6px; }
.dsh-trpg__tabs { display: flex; gap: 6px; }
.dsh-trpg__field { display: flex; flex-direction: column; gap: 3px; }
.dsh-trpg__field-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-trpg__check { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-trpg__empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--dsw-alias-label-secondary); text-align: center; padding: 24px; }
.dsh-trpg__empty-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-trpg__icon { font-size: 16px; line-height: 1; }
.dsh-trpg__section { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 7px; display: flex; flex-direction: column; gap: 6px; }
.dsh-trpg__pre { white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; margin: 0; padding: 7px 9px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font: inherit; font-size: 11.5px; line-height: 1.6; }
.dsh-trpg__outcome { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 7px 9px; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); font-size: 12px; display: flex; flex-direction: column; gap: 3px; }
`;

		/** 每个客户端实例只注入一次样式表，卸载时摘掉。 */
		function installStyles(ctx) {
			try {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", PLUGIN_ID);
				style.textContent = CSS;
				document.head.appendChild(style);
				if (typeof ctx.effect === "function") {
					ctx.effect(
						() => () => {
							try {
								style.remove();
							} catch (error) {
								/* 卸载尽力而为 */
							}
						},
						PLUGIN_ID + ": styles",
					);
				}
			} catch (error) {
				/* 样式是加分项，不阻塞挂载 */
			}
		}

		/* --------------------------------------------------------------- api -- */

		function messageOf(error) {
			return String((error && error.message) || error || "未知错误");
		}

		/** 把 `{ ok:false, error:{ code, message } }` 变成带 code 的 Error。 */
		function routeError(fallbackCode, fallbackMessage, payload) {
			const error = new Error((payload && payload.error && payload.error.message) || fallbackMessage);
			error.code = (payload && payload.error && payload.error.code) || fallbackCode;
			return error;
		}

		async function requestJSON(path, init) {
			const response = await fetch(path, init);
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (!payload || payload.ok !== true) {
				throw routeError("REQUEST_FAILED", "请求失败（HTTP " + response.status + "）", payload);
			}
			return payload;
		}

		const jsonInit = (body) => ({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

		const getState = () => requestJSON(API.state, { headers: { accept: "application/json" } });
		const getModels = () => requestJSON(API.models, { headers: { accept: "application/json" } });
		const sendCommand = (command) => requestJSON(API.command, jsonInit(command));
		const scenarioAction = (body) => requestJSON(API.scenario, jsonInit(body));
		const importState = (document_) => requestJSON(API.import, jsonInit(document_));

		/** 一个 SSE frame 可能带多行 data:，拼起来再 JSON.parse。 */
		function parseEventFrame(frame) {
			const lines = String(frame).split(/\r?\n/);
			const data = [];
			for (const line of lines) {
				if (line.indexOf("data:") === 0) data.push(line.slice(5).replace(/^\s/, ""));
			}
			if (!data.length) return null;
			try {
				return JSON.parse(data.join("\n"));
			} catch (error) {
				return null;
			}
		}

		/** POST 一个 SSE 路由，按 `\n\n` 手动切帧，逐帧交给 onEvent。 */
		async function streamSSE(path, body, onEvent, signal) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify(body),
				...(signal ? { signal } : {}),
			});
			const contentType = response.headers.get("content-type") || "";
			if (contentType.indexOf("text/event-stream") === -1) {
				let payload = null;
				try {
					payload = await response.json();
				} catch (error) {
					payload = null;
				}
				throw routeError("STREAM_FAILED", "请求失败（HTTP " + response.status + "）", payload);
			}
			if (!response.body) throw routeError("STREAM_FAILED", "宿主的响应没有可读的流", null);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				let index = buffer.indexOf("\n\n");
				while (index !== -1) {
					const frame = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					const event = parseEventFrame(frame);
					if (event) onEvent(event);
					index = buffer.indexOf("\n\n");
				}
			}
		}

		/* ------------------------------------------------------------ 视图工具 -- */

		/** 从 payload 里取 `{ state, view }`，容忍宿主少给字段。 */
		function stateAndView(payload) {
			return { state: (payload && payload.state) || null, view: (payload && payload.view) || null };
		}

		/** 本地只做「立刻显示」，权威永远是下一次 done/command 回来的 view。 */
		function withLogEntry(view, entry) {
			if (!view) return view;
			return { ...view, log: [...(view.log || []), entry] };
		}

		function withMood(view, mood, emoji) {
			if (!view || !view.campaign) return view;
			return { ...view, campaign: { ...view.campaign, scene: { ...view.campaign.scene, mood, moodEmoji: emoji } } };
		}

		/* ---------------------------------------------------------------- 组件 -- */

		function Button(props) {
			const className =
				"dsh-trpg__btn" +
				(props.primary ? " dsh-trpg__btn--primary" : "") +
				(props.danger ? " dsh-trpg__btn--danger" : "") +
				(props.on ? " dsh-trpg__btn--on" : "");
			return h(
				"button",
				{ type: "button", className, disabled: Boolean(props.disabled), title: props.title, onClick: props.onClick },
				props.children,
			);
		}

		function ModelPicker(props) {
			const options = (props.catalog && props.catalog.models) || [];
			const value = props.value || null;
			const known = Boolean(value && value.model) && options.some((item) => item.id === value.model && item.provider === value.provider);
			const catalogError = props.catalog && props.catalog.error;
			return h(
				"select",
				{
					className: "dsh-trpg__select",
					value: known ? value.provider + "\u0000" + value.model : "",
					disabled: options.length === 0,
					title: options.length ? "选择这次请求使用的模型" : catalogError || "环境里没有可用模型",
					onChange: (event) => {
						const parts = String(event.target.value).split("\u0000");
						if (parts[1]) props.onChange({ provider: parts[0], model: parts[1] });
						else props.onChange(null);
					},
				},
				[
					h("option", { key: "__none", value: "" }, options.length ? "使用默认模型" : "无可用模型"),
					...options.map((item) =>
						h(
							"option",
							{ key: item.provider + "/" + item.id, value: item.provider + "\u0000" + item.id },
							(item.name || item.id) + " · " + (item.providerName || item.provider),
						),
					),
				],
			);
		}

		function CampaignPanel(props) {
			const { view, runCommand, busy, dump, setDump, onError, onNotice, applyPayload } = props;
			const [form, setForm] = React.useState({ name: "", pcName: "", tone: "", premise: "" });
			const [rename, setRename] = React.useState("");
			const [pending, setPending] = React.useState("");
			const [showIO, setShowIO] = React.useState(false);
			const campaigns = (view && view.campaigns) || [];
			const activeId = view ? view.activeCampaignId : null;

			const create = () => {
				if (!form.name.trim()) {
					onNotice("先给战役起个名字");
					return;
				}
				runCommand({ type: "campaign.create", name: form.name, pcName: form.pcName, tone: form.tone, premise: form.premise });
				setForm({ name: "", pcName: "", tone: "", premise: "" });
			};

			const doExport = async () => {
				try {
					const payload = await getState();
					setDump(JSON.stringify(payload.state, null, 2));
					setShowIO(true);
					onNotice("已导出当前存档，可复制或下载");
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const doImport = async () => {
				let document_ = null;
				try {
					document_ = JSON.parse(dump);
				} catch (error) {
					onError("导入失败：不是合法 JSON");
					return;
				}
				try {
					const payload = await importState(document_);
					applyPayload(payload);
					onNotice("导入完成");
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const copy = () => {
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
						navigator.clipboard.writeText(dump);
						onNotice("已复制到剪贴板");
					} else {
						onError("这个环境没有剪贴板");
					}
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const download = () => {
				try {
					const blob = new Blob([dump], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = "dsh-trpg-state.json";
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
				} catch (error) {
					onError("下载失败：" + messageOf(error));
				}
			};

			return h("div", { className: "dsh-trpg__card" }, [
				h("div", { key: "head", className: "dsh-trpg__card-head" }, [
					h("span", { key: "t", className: "dsh-trpg__card-title" }, "战役"),
					h("span", { key: "n", className: "dsh-trpg__badge" }, campaigns.length + " 个"),
				]),
				h(
					"div",
					{ key: "list", className: "dsh-trpg__list" },
					campaigns.length === 0
						? h("div", { className: "dsh-trpg__hint" }, "还没有战役，在下面新建一个。")
						: campaigns.map((entry) =>
								h(
									"button",
									{
										key: entry.id,
										type: "button",
										className: "dsh-trpg__item" + (entry.id === activeId ? " dsh-trpg__item--active" : ""),
										onClick: () => runCommand({ type: "campaign.select", campaignId: entry.id }),
									},
									[h("span", { key: "n" }, entry.name), h("small", { key: "s" }, entry.tone + " · 第 " + entry.turn + " 回合")],
								),
							),
				),
				pending
					? h("div", { key: "confirm", className: "dsh-trpg__row" }, [
							h("span", { key: "t", className: "dsh-trpg__hint" }, "确定删除？"),
							h(
								Button,
								{
									key: "y",
									danger: true,
									busy,
									onClick: () => {
										runCommand({ type: "campaign.delete", campaignId: pending });
										setPending("");
									},
								},
								"删除",
							),
							h(Button, { key: "n", onClick: () => setPending("") }, "取消"),
						])
					: h("div", { key: "ops", className: "dsh-trpg__row" }, [
							h("input", {
								key: "rename",
								className: "dsh-trpg__input",
								placeholder: "改名…",
								value: rename,
								onChange: (event) => setRename(event.target.value),
							}),
							h(
								Button,
								{
									key: "savename",
									disabled: !activeId || !rename.trim(),
									onClick: () => {
										runCommand({ type: "campaign.patch", name: rename });
										setRename("");
									},
								},
								"改名",
							),
							h(Button, { key: "del", danger: true, disabled: !activeId, onClick: () => setPending(activeId) }, "删除"),
						]),
				h("details", { key: "new", className: "dsh-trpg__details" }, [
					h("summary", { key: "s" }, "新建战役"),
					h("div", { key: "form", className: "dsh-trpg__form" }, [
						h("input", {
							key: "name",
							className: "dsh-trpg__input",
							placeholder: "战役名",
							value: form.name,
							onChange: (event) => setForm({ ...form, name: event.target.value }),
						}),
						h("input", {
							key: "pc",
							className: "dsh-trpg__input",
							placeholder: "调查员名",
							value: form.pcName,
							onChange: (event) => setForm({ ...form, pcName: event.target.value }),
						}),
						h("input", {
							key: "tone",
							className: "dsh-trpg__input",
							placeholder: "基调（轻松 / 恐怖 / 沙雕）",
							value: form.tone,
							onChange: (event) => setForm({ ...form, tone: event.target.value }),
						}),
						h("textarea", {
							key: "premise",
							className: "dsh-trpg__textarea",
							placeholder: "一句话前提",
							value: form.premise,
							onChange: (event) => setForm({ ...form, premise: event.target.value }),
						}),
						h(Button, { key: "go", primary: true, disabled: busy, onClick: create }, "创建"),
					]),
				]),
				h("div", { key: "io", className: "dsh-trpg__row" }, [
					h(Button, { key: "exp", onClick: doExport }, "导出 JSON"),
					h(Button, { key: "imp", on: showIO, onClick: () => setShowIO((open) => !open) }, "导入 JSON"),
				]),
				showIO
					? h("div", { key: "io-body", className: "dsh-trpg__form" }, [
							h("textarea", {
								key: "dump",
								className: "dsh-trpg__textarea dsh-trpg__textarea--tall",
								placeholder: "把存档 JSON 贴在这里，然后点导入",
								value: dump,
								onChange: (event) => setDump(event.target.value),
							}),
							h("div", { key: "btns", className: "dsh-trpg__row" }, [
								h(Button, { key: "copy", disabled: !dump, onClick: copy }, "复制"),
								h(Button, { key: "dl", disabled: !dump, onClick: download }, "下载"),
								h(Button, { key: "do", primary: true, disabled: !dump.trim(), onClick: doImport }, "导入"),
							]),
						])
					: null,
			]);
		}

		function StatusCard(props) {
			const campaign = props.campaign;
			if (!campaign) {
				return h("div", { className: "dsh-trpg__card" }, [
					h("div", { key: "t", className: "dsh-trpg__card-title" }, "状态卡"),
					h("div", { key: "e", className: "dsh-trpg__hint" }, "没有活动的战役。"),
				]);
			}
			const scene = campaign.scene || {};
			const sceneLine = [scene.place, scene.time, (scene.present || []).join("、")].filter(Boolean).join(" · ");
			return h("div", { className: "dsh-trpg__card" }, [
				h("div", { key: "head", className: "dsh-trpg__card-head" }, [
					h("span", { key: "t", className: "dsh-trpg__card-title" }, campaign.name),
					h("span", { key: "b", className: "dsh-trpg__badge" }, (scene.moodEmoji || "") + " " + campaign.pcName),
				]),
				h("div", { key: "scene", className: "dsh-trpg__hint" }, sceneLine || "尚未描述场景"),
				h(
					"div",
					{ key: "stats", className: "dsh-trpg__rows" },
					campaign.stats.map((stat) =>
						h("div", { key: stat.id, className: "dsh-trpg__stat" }, [
							h("div", { key: "l", className: "dsh-trpg__stat-label" }, [
								h("span", { key: "n" }, stat.name),
								h("span", { key: "v" }, stat.value + " / " + stat.max),
							]),
							h("div", { key: "b", className: "dsh-trpg__bar" }, h("div", { className: "dsh-trpg__bar-fill", style: { width: stat.pct + "%" } })),
						]),
					),
				),
				h(
					"div",
					{ key: "clocks", className: "dsh-trpg__rows" },
					campaign.clocks.map((clock) =>
						h("div", { key: clock.id, className: "dsh-trpg__stat" }, [
							h("div", { key: "l", className: "dsh-trpg__stat-label" }, [
								h("span", { key: "n" }, (clock.done ? "✔ " : "") + clock.name),
								h("span", { key: "v" }, clock.value + " / " + clock.max),
							]),
							h(
								"div",
								{ key: "b", className: "dsh-trpg__bar" },
								h("div", { className: "dsh-trpg__bar-fill dsh-trpg__bar-fill--clock", style: { width: clock.pct + "%" } }),
							),
						]),
					),
				),
				campaign.inventory.length
					? h(
							"div",
							{ key: "inv", className: "dsh-trpg__tags" },
							campaign.inventory.map((item) => h("span", { key: item.id, className: "dsh-trpg__tag" }, item.name + " ×" + item.qty)),
						)
					: null,
				campaign.flags.length
					? h(
							"div",
							{ key: "flags", className: "dsh-trpg__tags" },
							campaign.flags.map((flag, index) => h("span", { key: "f" + index, className: "dsh-trpg__tag dsh-trpg__tag--flag" }, flag)),
						)
					: null,
				h(
					"div",
					{ key: "clues", className: "dsh-trpg__rows" },
					campaign.clues.items.map((clue) =>
						h("div", { key: clue.id, className: "dsh-trpg__clue" + (clue.found ? " dsh-trpg__clue--found" : "") }, (clue.found ? "◉ " : "○ ") + clue.text),
					),
				),
				h(
					"div",
					{ key: "ledger", className: "dsh-trpg__hint" },
					"账本 事实 " +
						campaign.ledger.counts.FACT +
						" · 信念 " +
						campaign.ledger.counts.BELIEF +
						" · 猜测 " +
						campaign.ledger.counts.HYPOTHESIS +
						" · 秘密 " +
						campaign.ledger.counts.SECRET +
						" · 线索 " +
						campaign.clues.found +
						"/" +
						campaign.clues.total,
				),
			]);
		}

		function DiceTray(props) {
			const { campaignId, runCommand, busy, autoRoll } = props;
			const [formula, setFormula] = React.useState("d100");
			const [dc, setDc] = React.useState("");
			const [check, setCheck] = React.useState({ skill: "", target: "50", difficulty: "regular", bonusDice: "0", penaltyDice: "0" });
			const disabled = !campaignId || busy;

			const roll = () => {
				const trimmed = formula.trim();
				if (!disabled && trimmed) {
					runCommand({ type: "dice.roll", formula: trimmed, ...(dc.trim() ? { dc: Number(dc) } : {}) });
				}
			};

			const doCheck = () => {
				if (disabled) return;
				runCommand({
					type: "dice.check",
					skill: check.skill,
					target: Number(check.target),
					difficulty: check.difficulty,
					bonusDice: Number(check.bonusDice),
					penaltyDice: Number(check.penaltyDice),
				});
			};

			return h("div", { className: "dsh-trpg__card" }, [
				h("div", { key: "head", className: "dsh-trpg__card-head" }, [
					h("span", { key: "t", className: "dsh-trpg__card-title" }, "骰子托盘"),
					h("span", { key: "b", className: "dsh-trpg__badge" }, autoRoll ? "自动掷骰" : "手动"),
				]),
				h("div", { key: "free", className: "dsh-trpg__row" }, [
					h("input", {
						key: "f",
						className: "dsh-trpg__input",
						placeholder: "公式，如 3d6+2",
						value: formula,
						onChange: (event) => setFormula(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") roll();
						},
					}),
					h("input", {
						key: "dc",
						className: "dsh-trpg__input",
						style: { maxWidth: 54 },
						placeholder: "DC",
						value: dc,
						onChange: (event) => setDc(event.target.value),
					}),
					h(Button, { key: "go", primary: true, disabled, onClick: roll }, "掷"),
				]),
				h(
					"div",
					{ key: "quick", className: "dsh-trpg__row" },
					QUICK_FORMULAS.map((item) =>
						h(
							Button,
							{
								key: item,
								disabled,
								onClick: () => {
									setFormula(item);
									runCommand({ type: "dice.roll", formula: item });
								},
							},
							item,
						),
					),
				),
				h("div", { key: "check", className: "dsh-trpg__section" }, [
					h("div", { key: "t", className: "dsh-trpg__hint" }, "技能检定（COC 7e）"),
					h("div", { key: "r1", className: "dsh-trpg__row" }, [
						h("input", {
							key: "skill",
							className: "dsh-trpg__input",
							placeholder: "技能名",
							value: check.skill,
							onChange: (event) => setCheck({ ...check, skill: event.target.value }),
						}),
						h("input", {
							key: "target",
							className: "dsh-trpg__input",
							style: { maxWidth: 70 },
							type: "number",
							placeholder: "目标",
							value: check.target,
							onChange: (event) => setCheck({ ...check, target: event.target.value }),
						}),
					]),
					h("div", { key: "r2", className: "dsh-trpg__row" }, [
						h(
							"select",
							{
								key: "diff",
								className: "dsh-trpg__select",
								value: check.difficulty,
								onChange: (event) => setCheck({ ...check, difficulty: event.target.value }),
							},
							DIFFICULTIES.map((item) => h("option", { key: item.value, value: item.value }, item.label)),
						),
						h("input", {
							key: "bonus",
							className: "dsh-trpg__input",
							style: { maxWidth: 62 },
							type: "number",
							min: 0,
							max: 2,
							title: "奖励骰 0..2",
							value: check.bonusDice,
							onChange: (event) => setCheck({ ...check, bonusDice: event.target.value }),
						}),
						h("input", {
							key: "penalty",
							className: "dsh-trpg__input",
							style: { maxWidth: 62 },
							type: "number",
							min: 0,
							max: 2,
							title: "惩罚骰 0..2",
							value: check.penaltyDice,
							onChange: (event) => setCheck({ ...check, penaltyDice: event.target.value }),
						}),
						h(Button, { key: "go", disabled, onClick: doCheck }, "检定"),
					]),
				]),
			]);
		}

		function LogEntry(props) {
			const entry = props.entry;
			const meta = entry.meta || {};
			if (entry.role === "dice") {
				const isCheck = meta.kind === "check";
				return h("div", { className: "dsh-trpg__dice" }, [
					h("span", { key: "f", className: "dsh-trpg__chip" }, isCheck ? meta.skill || "检定" : meta.formula || "骰"),
					h("span", { key: "t", className: "dsh-trpg__chip-total" }, isCheck ? meta.level || "" : String(meta.total === undefined ? "" : meta.total)),
					h("span", { key: "d", className: "dsh-trpg__dice-text" }, entry.text),
				]);
			}
			if (entry.role === "gm" && meta.kind === "snark") {
				return h("div", { className: "dsh-trpg__snark" }, "（GM 场外音）" + entry.text);
			}
			const who = entry.role === "player" ? "我" : entry.role === "system" ? "情报" : (props.emoji || "") + " GM";
			return h("div", { className: "dsh-trpg__msg dsh-trpg__msg--" + (entry.role || "system") }, [
				h("div", { key: "r", className: "dsh-trpg__msg-role" }, who),
				h("div", { key: "b", className: "dsh-trpg__msg-body" }, entry.text),
			]);
		}

		function LogStream(props) {
			const { view, streaming, streamText } = props;
			const boxRef = React.useRef(null);
			const entries = (view && view.log) || [];
			const scene = view && view.campaign ? view.campaign.scene : null;
			const emoji = (scene && scene.moodEmoji) || "";
			React.useEffect(() => {
				const box = boxRef.current;
				if (box) box.scrollTop = box.scrollHeight;
			}, [entries.length, streamText]);
			return h("div", { className: "dsh-trpg__log", ref: boxRef }, [
				entries.length === 0 && !streaming
					? h("div", { key: "empty", className: "dsh-trpg__hint" }, "还没有线报。开一个战役，然后在下面说你要做什么。")
					: null,
				...entries.map((entry, index) => h(LogEntry, { key: entry.id || "log-" + index, entry, emoji })),
				streaming
					? h("div", { key: "live", className: "dsh-trpg__msg dsh-trpg__msg--gm" }, [
							h("div", { key: "r", className: "dsh-trpg__msg-role" }, [
								h("span", { key: "e" }, (emoji || "") + " GM"),
								h("span", { key: "b", className: "dsh-trpg__badge" }, "叙述中"),
							]),
							h("div", { key: "b", className: "dsh-trpg__msg-body" }, [
								streamText,
								h("span", { key: "c", className: "dsh-trpg__cursor" }),
							]),
						])
					: null,
			]);
		}

		function Composer(props) {
			const { disabled, streaming, draft, setDraft, onSend, onStop } = props;
			return h("div", { className: "dsh-trpg__composer" }, [
				h("textarea", {
					key: "ta",
					className: "dsh-trpg__textarea",
					placeholder: disabled ? "先新建或选择一个战役" : "你打算做什么？（Enter 发送，Shift+Enter 换行）",
					value: draft,
					disabled,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent && event.nativeEvent.isComposing)) {
							event.preventDefault();
							onSend();
						}
					},
				}),
				h("div", { key: "row", className: "dsh-trpg__composer-row" }, [
					h(Button, { key: "send", primary: true, disabled: disabled || streaming || !String(draft).trim(), onClick: onSend }, "发送"),
					streaming ? h(Button, { key: "stop", onClick: onStop }, "■ 停止") : null,
					h("span", { key: "sp", className: "dsh-trpg__spacer" }),
					h("span", { key: "hint", className: "dsh-trpg__hint" }, "骰子由宿主掷出，模型碰不到随机数"),
				]),
			]);
		}

		function BribePanel(props) {
			const { view, campaignId, model, runCommand, applyPayload, onError } = props;
			const campaign = (view && view.campaign) || null;
			const bribes = (campaign && campaign.bribes) || [];
			const [selected, setSelected] = React.useState("");
			const [offer, setOffer] = React.useState("");
			const [streamText, setStreamText] = React.useState("");
			const [streaming, setStreaming] = React.useState(false);
			const [outcome, setOutcome] = React.useState(null);
			const [openForm, setOpenForm] = React.useState({ npcName: "", want: "", secret: "" });
			const current = bribes.find((item) => item.id === selected) || bribes.find((item) => item.canOffer) || bribes[0] || null;

			const talk = async () => {
				if (!campaignId || !current || !offer.trim() || streaming) return;
				setStreamText("");
				setOutcome(null);
				setStreaming(true);
				try {
					const payload = { campaignId, bribeId: current.id, offer, ...(model ? { model } : {}) };
					await streamSSE(API.bribe, payload, (event) => {
						if (event.type === "delta") setStreamText((prev) => prev + (event.text || ""));
						else if (event.type === "verdict") {
							const bribe = event.bribe || {};
							setOutcome({
								verdict: event.verdict,
								reason: event.reason,
								suspicion: bribe.suspicion,
								suspicionLabel: bribe.suspicionLabel || "",
								revealed: event.revealed,
							});
						} else if (event.type === "done") {
							applyPayload(event);
							setStreamText("");
						} else if (event.type === "error") onError(event.message || "谈判失败");
					});
					setOffer("");
				} catch (error) {
					onError(messageOf(error));
				} finally {
					setStreaming(false);
				}
			};

			const reveal = () => {
				if (current) runCommand({ type: "bribe.reveal", bribeId: current.id });
			};

			const openBribe = () => {
				if (!openForm.npcName.trim()) {
					onError("要贿赂谁？");
					return;
				}
				runCommand({ type: "bribe.open", npcName: openForm.npcName, want: openForm.want, secret: openForm.secret });
				setOpenForm({ npcName: "", want: "", secret: "" });
			};

			return h("div", { className: "dsh-trpg__card" }, [
				h("div", { key: "head", className: "dsh-trpg__card-head" }, [
					h("span", { key: "t", className: "dsh-trpg__card-title" }, "贿赂"),
					h("span", { key: "b", className: "dsh-trpg__badge" }, bribes.length + " 笔"),
				]),
				h(
					"div",
					{ key: "list", className: "dsh-trpg__list" },
					bribes.length === 0
						? h("div", { className: "dsh-trpg__hint" }, "还没有交易。先「新开一笔」。")
						: bribes.map((item) =>
								h(
									"button",
									{
										key: item.id,
										type: "button",
										className: "dsh-trpg__item" + (current && item.id === current.id ? " dsh-trpg__item--active" : ""),
										onClick: () => setSelected(item.id),
									},
									[
										h("span", { key: "n" }, item.npcName + " · " + (BRIBE_STATUS_LABELS[item.status] || item.status)),
										h("small", { key: "s" }, "怀疑度 " + item.suspicion + (item.price ? " · " + item.price : "")),
									],
								),
							),
				),
				current
					? h("div", { key: "detail", className: "dsh-trpg__section" }, [
							h("div", { key: "want", className: "dsh-trpg__hint" }, "想要：" + (current.want || "（没说）")),
							h(
								"div",
								{ key: "susp" },
								[
									h("div", { key: "l", className: "dsh-trpg__stat-label" }, [
										h("span", { key: "a" }, "怀疑度 " + (current.suspicionLabel || "")),
										h("span", { key: "b" }, current.suspicion + " / " + ((view && view.limits && view.limits.suspicionMax) || 5)),
									]),
									h(
										"div",
										{ key: "bar", className: "dsh-trpg__bar" },
										h("div", {
											className: "dsh-trpg__bar-fill dsh-trpg__bar-fill--clock",
											style: { width: Math.min(100, ((current.suspicion || 0) / ((view && view.limits && view.limits.suspicionMax) || 5)) * 100) + "%" },
										}),
									),
								],
							),
							h("textarea", {
								key: "offer",
								className: "dsh-trpg__textarea",
								placeholder: "你拿什么换？（比如：一瓶威士忌 + 我替你瞒着巡警）",
								value: offer,
								onChange: (event) => setOffer(event.target.value),
							}),
							h("div", { key: "btns", className: "dsh-trpg__row" }, [
								h(Button, { key: "talk", primary: true, disabled: !campaignId || !offer.trim() || streaming, onClick: talk }, "谈判"),
								h(Button, { key: "reveal", disabled: !campaignId, onClick: reveal }, "揭露情报"),
							]),
							streaming && streamText
								? h("div", { key: "live", className: "dsh-trpg__msg dsh-trpg__msg--gm" }, [
										h("div", { key: "r", className: "dsh-trpg__msg-role" }, current.npcName + " 在掂量"),
										h("div", { key: "b", className: "dsh-trpg__msg-body" }, streamText),
									])
								: null,
							outcome
								? h("div", { key: "outcome", className: "dsh-trpg__outcome" }, [
										h("strong", { key: "v" }, VERDICT_LABELS[outcome.verdict] || outcome.verdict),
										h("span", { key: "r" }, outcome.reason || ""),
										h("span", { key: "s" }, "怀疑度 " + (outcome.suspicion === undefined || outcome.suspicion === null ? "?" : outcome.suspicion) + "（" + (outcome.suspicionLabel || "") + "）"),
										h("span", { key: "x" }, outcome.revealed ? "对方松了口：" + outcome.revealed : "没有吐露任何情报"),
									])
								: null,
						])
					: null,
				h("div", { key: "open", className: "dsh-trpg__section" }, [
					h("div", { key: "t", className: "dsh-trpg__hint" }, "新开一笔"),
					h("input", {
						key: "npc",
						className: "dsh-trpg__input",
						placeholder: "NPC 名字",
						value: openForm.npcName,
						onChange: (event) => setOpenForm({ ...openForm, npcName: event.target.value }),
					}),
					h("input", {
						key: "want",
						className: "dsh-trpg__input",
						placeholder: "你想从他那里要什么",
						value: openForm.want,
						onChange: (event) => setOpenForm({ ...openForm, want: event.target.value }),
					}),
					h("input", {
						key: "secret",
						className: "dsh-trpg__input",
						placeholder: "他藏着的秘密（成功才会揭露）",
						value: openForm.secret,
						onChange: (event) => setOpenForm({ ...openForm, secret: event.target.value }),
					}),
					h(Button, { key: "go", disabled: !campaignId, onClick: openBribe }, "开一笔"),
				]),
			]);
		}

		function ScenarioPanel(props) {
			const { view, campaignId, applyPayload, onError, onNotice } = props;
			const campaign = (view && view.campaign) || null;
			const info = (campaign && campaign.scenario) || { title: "", sectionCount: 0, chars: 0, headings: [] };
			const [title, setTitle] = React.useState("");
			const [source, setSource] = React.useState("");
			const [query, setQuery] = React.useState("");
			const [sections, setSections] = React.useState(null);
			const [hits, setHits] = React.useState([]);
			const [section, setSection] = React.useState(null);

			const doImport = async () => {
				if (!campaignId) {
					onError("先开一个战役");
					return;
				}
				if (!source.trim()) {
					onError("先把剧本原文贴进来");
					return;
				}
				try {
					const payload = await scenarioAction({ campaignId, action: "import", source, title: title.trim() || undefined });
					applyPayload(payload);
					onNotice("剧本已导入：" + (payload.scenario ? payload.scenario.sectionCount + " 节" : ""));
					setSource("");
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const doList = async () => {
				if (!campaignId) {
					onError("先开一个战役");
					return;
				}
				try {
					const payload = await scenarioAction({ campaignId, action: "list" });
					setSections((payload.scenario && payload.scenario.sections) || []);
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const doSearch = async () => {
				if (!campaignId || !query.trim()) return;
				try {
					const payload = await scenarioAction({ campaignId, action: "search", query });
					setHits(payload.hits || []);
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const doRead = async (id) => {
				try {
					const payload = await scenarioAction({ campaignId, action: "read", sectionId: id });
					setSection(payload.section || null);
				} catch (error) {
					onError(messageOf(error));
				}
			};

			const catalog = sections || info.headings || [];

			return h("div", { className: "dsh-trpg__card" }, [
				h("div", { key: "head", className: "dsh-trpg__card-head" }, [
					h("span", { key: "t", className: "dsh-trpg__card-title" }, info.title || "未导入剧本"),
					h("span", { key: "b", className: "dsh-trpg__badge" }, info.sectionCount + " 节"),
				]),
				h("div", { key: "meta", className: "dsh-trpg__hint" }, info.chars ? info.chars + " 字原文" : "把剧本粘进来，模型只看目录摘要，正文靠检索。"),
				h("div", { key: "import", className: "dsh-trpg__section" }, [
					h("input", {
						key: "title",
						className: "dsh-trpg__input",
						placeholder: "剧本标题（可省）",
						value: title,
						onChange: (event) => setTitle(event.target.value),
					}),
					h("textarea", {
						key: "src",
						className: "dsh-trpg__textarea dsh-trpg__textarea--tall",
						placeholder: "在这里粘贴剧本原文…",
						value: source,
						onChange: (event) => setSource(event.target.value),
					}),
					h("div", { key: "btns", className: "dsh-trpg__row" }, [
						h(Button, { key: "go", primary: true, disabled: !campaignId || !source.trim(), onClick: doImport }, "导入"),
						h(Button, { key: "list", disabled: !campaignId, onClick: doList }, "目录"),
					]),
				]),
				h("div", { key: "search", className: "dsh-trpg__section" }, [
					h("div", { key: "row", className: "dsh-trpg__row" }, [
						h("input", {
							key: "q",
							className: "dsh-trpg__input",
							placeholder: "检索关键词",
							value: query,
							onChange: (event) => setQuery(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter") doSearch();
							},
						}),
						h(Button, { key: "go", disabled: !campaignId || !query.trim(), onClick: doSearch }, "检索"),
					]),
					h(
						"div",
						{ key: "hits", className: "dsh-trpg__list" },
						hits.length === 0
							? h("div", { className: "dsh-trpg__hint" }, "没有命中。")
							: hits.map((hit) =>
									h(
										"button",
										{ key: hit.id + "-" + hit.index, type: "button", className: "dsh-trpg__item", onClick: () => doRead(hit.id) },
										[h("span", { key: "h" }, hit.id + " " + hit.heading), h("small", { key: "s" }, hit.snippet)],
									),
								),
					),
				]),
				h(
					"div",
					{ key: "sections", className: "dsh-trpg__list" },
					catalog.length === 0
						? null
						: catalog.map((item) =>
								h("button", { key: item.id, type: "button", className: "dsh-trpg__item", onClick: () => doRead(item.id) }, [
									h("span", { key: "h" }, item.id + " " + item.heading),
									h("small", { key: "s" }, "第 " + item.level + " 级" + (item.chars ? " · " + item.chars + " 字" : "")),
								]),
							),
				),
				section
					? h("div", { key: "body", className: "dsh-trpg__section" }, [
							h("div", { key: "h", className: "dsh-trpg__card-title" }, section.id + " " + section.heading),
							h("pre", { key: "b", className: "dsh-trpg__pre" }, section.body),
						])
					: null,
			]);
		}

		function SettingsPanel(props) {
			const { view, catalog, onSelect } = props;
			const settings = (view && view.settings) || { model: null, autoRoll: true, snark: 3, maxContextChars: CONTEXT_LIMITS.fallback };
			const runCommand = props.runCommand;
			const [context, setContext] = React.useState(String(settings.maxContextChars));
			return h("div", { className: "dsh-trpg__card" }, [
				h("div", { key: "t", className: "dsh-trpg__card-title" }, "设置"),
				h("div", { key: "model", className: "dsh-trpg__field" }, [
					h("span", { key: "l", className: "dsh-trpg__field-label" }, "模型"),
					h(ModelPicker, { catalog, value: props.selection || settings.model, onChange: onSelect }),
				]),
				catalog && catalog.error ? h("div", { key: "me", className: "dsh-trpg__hint" }, catalog.error) : null,
				h("label", { key: "auto", className: "dsh-trpg__check" }, [
					h("input", {
						key: "c",
						type: "checkbox",
						checked: Boolean(settings.autoRoll),
						onChange: (event) => runCommand({ type: "settings.patch", autoRoll: event.target.checked }),
					}),
					h("span", { key: "l" }, "自动掷骰（模型请求掷骰时立刻执行）"),
				]),
				h("div", { key: "snark", className: "dsh-trpg__field" }, [
					h("span", { key: "l", className: "dsh-trpg__field-label" }, "吐槽浓度 " + settings.snark + " / " + SNARK_MAX),
					h("input", {
						key: "r",
						type: "range",
						min: 0,
						max: SNARK_MAX,
						step: 1,
						value: settings.snark,
						onChange: (event) => runCommand({ type: "settings.patch", snark: Number(event.target.value) }),
					}),
				]),
				h("div", { key: "ctx", className: "dsh-trpg__field" }, [
					h("span", { key: "l", className: "dsh-trpg__field-label" }, "上下文上限（字符）"),
					h("div", { key: "row", className: "dsh-trpg__row" }, [
						h("input", {
							key: "i",
							className: "dsh-trpg__input",
							type: "number",
							min: CONTEXT_LIMITS.min,
							max: CONTEXT_LIMITS.max,
							value: context,
							onChange: (event) => setContext(event.target.value),
						}),
						h(Button, { key: "s", onClick: () => runCommand({ type: "settings.patch", maxContextChars: Number(context) }) }, "保存"),
					]),
				]),
				view && view.limits
					? h(
							"div",
							{ key: "limits", className: "dsh-trpg__hint" },
							"每战役最多 " + view.limits.maxLogPerCampaign + " 条线报 · 怀疑度上限 " + view.limits.suspicionMax,
						)
					: null,
			]);
		}

		function Workspace(props) {
			const [view, setView] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [notice, setNotice] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [draft, setDraft] = React.useState("");
			const [streamText, setStreamText] = React.useState("");
			const [streaming, setStreaming] = React.useState(false);
			const [tool, setTool] = React.useState("bribe");
			const [selection, setSelection] = React.useState(null);
			const [catalog, setCatalog] = React.useState({ models: [], providers: [], fallback: null, error: null });
			const [dump, setDump] = React.useState("");
			const abortRef = React.useRef(null);

			const campaignId = view ? view.activeCampaignId : null;
			const campaign = view ? view.campaign : null;
			const settings = (view && view.settings) || { model: null, autoRoll: true, snark: 3, maxContextChars: CONTEXT_LIMITS.fallback };
			const effectiveModel = selection || settings.model || (catalog && catalog.fallback) || null;

			const applyPayload = (payload) => {
				const next = stateAndView(payload);
				if (next.view) setView(next.view);
			};

			const refresh = async () => {
				try {
					const payload = await getState();
					applyPayload(payload);
					setError(null);
				} catch (err) {
					setError(messageOf(err));
				}
			};

			React.useEffect(() => {
				refresh();
				getModels()
					.then((payload) =>
						setCatalog({ models: payload.models || [], providers: payload.providers || [], fallback: payload.fallback || null, error: null }),
					)
					.catch((err) => setCatalog({ models: [], providers: [], fallback: null, error: messageOf(err) }));
			}, []);

			const runCommand = async (command) => {
				setBusy(true);
				try {
					const payload = await sendCommand({ ...(campaignId ? { campaignId } : {}), ...command });
					applyPayload(payload);
					setError(null);
					return (payload && payload.result) || null;
				} catch (err) {
					setError(messageOf(err));
					return null;
				} finally {
					setBusy(false);
				}
			};

			const sendTurn = async (content) => {
				const text = String(content || "").trim();
				if (!text || streaming) return;
				setDraft("");
				setStreamText("");
				setStreaming(true);
				setError(null);
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				abortRef.current = controller;
				try {
					const body = { campaignId, content: text, ...(effectiveModel ? { model: effectiveModel } : {}) };
					await streamSSE(
						API.turn,
						body,
						(event) => {
							if (event.type === "delta") setStreamText((prev) => prev + (event.text || ""));
							else if (event.type === "mood") setView((prev) => withMood(prev, event.mood, event.emoji));
							else if (event.type === "roll")
								setView((prev) =>
									withLogEntry(prev, {
										id: "live-roll-" + Date.now(),
										role: "dice",
										text: (event.text || "") + " = " + event.total,
										meta: event,
										createdAt: Date.now(),
									}),
								);
							else if (event.type === "roll-error") setNotice("模型给的公式不合法：" + event.formula);
							else if (event.type === "snark") setView((prev) => withLogEntry(prev, event.entry));
							else if (event.type === "done") {
								setView(event.view || null);
								setStreamText("");
							} else if (event.type === "error") setError(event.message || "模型调用失败");
						},
						controller ? controller.signal : undefined,
					);
				} catch (err) {
					if (err && err.name === "AbortError") setNotice("已停止本轮叙述");
					else setError(messageOf(err));
				} finally {
					abortRef.current = null;
					setStreaming(false);
				}
			};

			const stop = () => {
				if (abortRef.current) {
					try {
						abortRef.current.abort();
					} catch (err) {
						/* 已结束 */
					}
				}
			};

			const suggestions = (campaign && campaign.suggestions) || [];
			const tabButton = (id, label) => h(Button, { key: id, on: tool === id, onClick: () => setTool(id) }, label);

			return h("div", { className: "dsh-trpg" }, [
				h("div", { key: "bar", className: "dsh-trpg__bar" }, [
					props.onExit ? h(Button, { key: "exit", onClick: props.onExit, title: "回到会话" }, "← 返回会话") : null,
					h("span", { key: "title", className: "dsh-trpg__title" }, "AI 跑团"),
					h("span", { key: "turn", className: "dsh-trpg__badge" }, campaign ? "第 " + campaign.turn + " 回合" : "未开战役"),
					h("span", { key: "sp", className: "dsh-trpg__spacer" }),
					h(ModelPicker, {
						key: "model",
						catalog,
						value: effectiveModel,
						onChange: (next) => {
							setSelection(next);
							runCommand({ type: "settings.patch", model: next });
						},
					}),
					h(Button, { key: "refresh", disabled: busy, onClick: refresh }, "刷新"),
				]),
				error ? h("div", { key: "err", className: "dsh-trpg__error" }, error) : null,
				notice ? h("div", { key: "notice", className: "dsh-trpg__notice" }, notice) : null,
				h("div", { key: "body", className: "dsh-trpg__body" }, [
					h("div", { key: "left", className: "dsh-trpg__col dsh-trpg__col--left" }, [
						h(CampaignPanel, {
							key: "campaigns",
							view,
							runCommand,
							busy,
							dump,
							setDump,
							applyPayload,
							onError: setError,
							onNotice: setNotice,
						}),
						h(StatusCard, { key: "status", campaign }),
						h(DiceTray, { key: "dice", campaignId, runCommand, busy, autoRoll: settings.autoRoll }),
					]),
					h("div", { key: "center", className: "dsh-trpg__col dsh-trpg__col--center" }, [
						h(LogStream, { key: "log", view, streaming, streamText }),
						campaignId && suggestions.length
							? h(
									"div",
									{ key: "sug", className: "dsh-trpg__suggestions" },
									suggestions.map((item) =>
										h(
											Button,
											{
												key: item.id,
												disabled: busy || streaming,
												onClick: () => {
													if (item.action === "send") sendTurn(item.payload);
													else setTool("bribe");
												},
											},
											item.label,
										),
									),
								)
							: null,
						h(Composer, {
							key: "composer",
							disabled: !campaignId,
							streaming,
							draft,
							setDraft,
							onSend: () => sendTurn(draft),
							onStop: stop,
						}),
					]),
					h("div", { key: "right", className: "dsh-trpg__col dsh-trpg__col--right" }, [
						h("div", { key: "tabs", className: "dsh-trpg__tabs" }, [
							tabButton("bribe", "贿赂"),
							tabButton("scenario", "剧本"),
							tabButton("settings", "设置"),
						]),
						tool === "bribe"
							? h(BribePanel, { key: "bribe", view, campaignId, model: effectiveModel, runCommand, applyPayload, onError: setError })
							: null,
						tool === "scenario"
							? h(ScenarioPanel, { key: "scenario", view, campaignId, applyPayload, onError: setError, onNotice: setNotice })
							: null,
						tool === "settings"
							? h(SettingsPanel, {
									key: "settings",
									view,
									catalog,
									selection,
									onSelect: (next) => {
										setSelection(next);
										runCommand({ type: "settings.patch", model: next });
									},
									runCommand,
								})
							: null,
					]),
				]),
			]);
		}

		/* --------------------------------------------------------------- apply -- */

		/**
		 * main 是 `shadows-shipped-ui` 的 keyed slot：它把会话视图整块换掉，所以渲染失败时
		 * 用户不能连「打字回去」的路都没有。fallback 永远带一个返回会话的按钮。
		 */
		class PanelBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error) {
				console.error(PLUGIN_ID + ": 面板渲染失败", error);
			}

			render() {
				const error = this.state.error;
				if (!error) return this.props.children;
				return h("div", { className: "dsh-trpg" }, [
					h("div", { key: "bar", className: "dsh-trpg__bar" }, [
						this.props.onExit ? h(Button, { key: "exit", onClick: this.props.onExit }, "← 返回会话") : null,
						h("span", { key: "title", className: "dsh-trpg__title" }, "AI 跑团"),
					]),
					h("div", { key: "body", className: "dsh-trpg__empty" }, [
						h("div", { key: "h", className: "dsh-trpg__empty-title" }, "面板渲染失败"),
						h("div", { key: "m" }, String((error && error.message) || error)),
					]),
				]);
			}
		}

		/** 侧栏图标：宿主把它包进自己的按钮里，所以这里只画字形。 */
		function PanelIcon() {
			return h("span", { className: "dsh-trpg__icon", "aria-hidden": "true" }, "🎲");
		}

		/** 父 slot 可能还没声明，先 inject 等它；这条路不通就直接注册。 */
		function registerInto(slots, meta, Component) {
			if (typeof slots.inject === "function") {
				try {
					return slots.inject(meta.name, function () {
						return slots.register(meta, Component);
					});
				} catch (error) {
					/* 落到直接注册 */
				}
			}
			try {
				const off = slots.register(meta, Component);
				return typeof off === "function" ? off : function () {};
			} catch (error) {
				console.warn(PLUGIN_ID + ": 无法注册到 " + meta.name, error);
				return function () {};
			}
		}

		function apply(ctx) {
			installStyles(ctx);

			const disposers = [];
			const slots = typeof ctx.get === "function" ? ctx.get("slots") : null;
			if (!slots) {
				console.warn(PLUGIN_ID + ": slots 服务不可用，跑团面板不会挂载");
				return;
			}

			// main 面板顶掉了会话视图，所以必须随时能还给用户。selectPanel(null) 是
			// 文档里的「返回会话」调用，故意延迟到点击时再取 layout，服务晚到也能用。
			function exitToConversation() {
				const layout = typeof ctx.get === "function" ? ctx.get("layout") : null;
				if (!layout || typeof layout.selectPanel !== "function") {
					console.warn(PLUGIN_ID + ": layout 服务不可用，无法返回会话");
					return;
				}
				try {
					layout.selectPanel(null);
				} catch (error) {
					console.warn(PLUGIN_ID + ": 返回会话失败", error);
				}
			}

			function PanelRoot(props) {
				return h(PanelBoundary, { onExit: exitToConversation }, h(Workspace, { ...(props || {}), onExit: exitToConversation }));
			}

			// 侧栏图标与 keyed main 共用一个 id：图标负责把面板调出来。
			disposers.push(
				registerInto(slots, { name: "sidebar.panellist", id: PANEL_ID, order: 60, label: () => "AI 跑团" }, PanelIcon),
			);
			disposers.push(registerInto(slots, { name: "main", key: PANEL_ID }, PanelRoot));

			if (typeof ctx.effect === "function") {
				ctx.effect(() => () => {
					for (const dispose of disposers) {
						try {
							if (typeof dispose === "function") dispose();
						} catch (error) {
							/* 卸载尽力而为 */
						}
					}
				}, PLUGIN_ID + ": slots");
			}
		}

		return { name: PLUGIN_ID, inject: ["slots"], apply };
	},
});
