import type { DraftStore } from "../../lina-client/src/draft.ts";
import { element, setText } from "./render.ts";

type InstallEvent = Event & { prompt(): Promise<{ outcome: string }> };
/** Only an explicit update click may reload; activation alone never clears input. */
export function installPwa(
	draftSource: DraftStore | (() => DraftStore),
	fullText: () => string,
): void {
	const install = element("install-app", HTMLButtonElement),
		update = element("update-app", HTMLButtonElement),
		status = element("app-install-status", HTMLParagraphElement),
		updateStatus = element("app-update-status", HTMLParagraphElement),
		checkUpdate = element("check-app-update", HTMLButtonElement),
		help = element("install-help", HTMLDetailsElement);
	let installEvent: InstallEvent | undefined;
	let next: ServiceWorker | undefined;
	let registration: ServiceWorkerRegistration | undefined;
	checkUpdate.disabled = true;
	setText(status, "브라우저로 사용 중");
	window.addEventListener("beforeinstallprompt", (event) => {
		if (!("prompt" in event) || typeof event.prompt !== "function") return;
		event.preventDefault();
		installEvent = event as InstallEvent;
		install.hidden = false;
		setText(status, "");
		help.hidden = true;
	});
	install.addEventListener("click", () => {
		const event = installEvent;
		if (!event) return;
		installEvent = undefined;
		install.hidden = true;
		help.hidden = false;
		void event.prompt().then(
			(result) =>
				setText(
					status,
					result.outcome === "accepted" ? "설치 요청 완료" : "설치 취소됨",
				),
			() => setText(status, "브라우저 메뉴 → 앱 설치"),
		);
	});
	window.addEventListener("appinstalled", () => {
		installEvent = undefined;
		install.hidden = true;
		help.hidden = true;
		setText(status, "설치됨");
	});
	const persist = () => {
		const text = fullText();
		if (
			(typeof draftSource === "function"
				? draftSource()
				: draftSource
			).saveDraft(text) ||
			!text
		)
			return true;
		setText(updateStatus, "입력 저장 실패 · 내용 복사 후 새로고침");
		return false;
	};
	update.addEventListener("click", () => {
		const worker = next;
		if (!worker || !persist()) return;
		update.disabled = true;
		void (async () => {
			try {
				if (worker.state !== "activated")
					await new Promise<void>((resolve, reject) => {
						const finish = (error?: Error) => {
							clearTimeout(deadline);
							worker.removeEventListener("statechange", check);
							error ? reject(error) : resolve();
						};
						const check = () => {
							if (worker.state === "activated") finish();
							else if (worker.state === "redundant")
								finish(new Error("Update replaced"));
						};
						const deadline = setTimeout(
							() => finish(new Error("Update timeout")),
							10000,
						);
						worker.addEventListener("statechange", check);
						worker.postMessage("apply-update");
						check();
					});
				if (persist()) location.reload();
			} catch {
				setText(updateStatus, "업데이트 실패 · 입력 유지됨");
			} finally {
				update.disabled = false;
			}
		})();
	});
	if (!("serviceWorker" in navigator) || !window.isSecureContext) {
		setText(status, "설치에 보안 연결이 필요합니다.");
		setText(updateStatus, "업데이트를 사용할 수 없습니다.");
		return;
	}
	const waiting = (worker: ServiceWorker | null) => {
		if (worker) {
			next = worker;
			update.hidden = false;
			setText(updateStatus, "업데이트 가능");
		}
	};
	const prepare = async () => {
		const current = await navigator.serviceWorker.register("/sw.js", {
			scope: "/",
			updateViaCache: "none",
		});
		registration = current;
		const watch = (worker: ServiceWorker | null) => {
			if (!worker) return;
			const state = () => {
				if (worker.state === "installed" && navigator.serviceWorker.controller)
					waiting(current.waiting ?? worker);
				else if (worker.state === "activated")
					setText(updateStatus, next ? "업데이트 가능" : "최신 상태");
				else if (worker.state === "redundant")
					setText(updateStatus, "업데이트 준비 실패 · 다시 시도해주세요.");
				else if (worker.state === "installing")
					setText(updateStatus, "업데이트 준비 중");
			};
			worker.addEventListener("statechange", state);
			state();
		};
		setText(updateStatus, "최신 상태");
		waiting(current.waiting);
		watch(current.installing);
		current.addEventListener("updatefound", () => watch(current.installing));
		return current;
	};
	void prepare()
		.then(() => {
			checkUpdate.disabled = false;
		})
		.catch(() => {
			setText(updateStatus, "업데이트 준비 실패 · 다시 시도해주세요.");
			checkUpdate.disabled = false;
		});
	if (matchMedia("(display-mode: standalone)").matches) {
		setText(status, "설치됨");
		help.hidden = true;
	}
	checkUpdate.addEventListener("click", () => {
		checkUpdate.disabled = true;
		setText(updateStatus, "업데이트 확인 중");
		void (async () => {
			try {
				const current = registration ?? (await prepare());
				await current.update();
				if (current.waiting) waiting(current.waiting);
				else if (current.installing) setText(updateStatus, "업데이트 준비 중");
				else setText(updateStatus, next ? "업데이트 가능" : "최신 상태");
			} catch {
				setText(updateStatus, "업데이트 확인 실패 · 다시 시도해주세요.");
			} finally {
				checkUpdate.disabled = false;
			}
		})();
	});
}
