// Tiny DOM helpers, modal dialogs, menus and toasts.

type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ------------------------------------------------------------ icons (inline SVG, Lucide-style strokes)

const ICONS: Record<string, string> = {
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="8"/>',
  insert: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/>',
  rotl: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotr: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  sign: '<path d="M3 17c3-6 5-9 7-9 3 0-2 9 1 9 2 0 3-4 5-4 1.5 0 1 2.5 2.5 2.5S21 14 21 14"/><path d="M3 21h18"/>',
  md: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6M16 9v6M14 13l2 2 2-2"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  pointer: '<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
  rect: '<rect x="3.5" y="6" width="17" height="12" rx="1"/>',
  oval: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>',
  arrow: '<path d="M5 19 19 5"/><path d="M9 5h10v10"/>',
  callout: '<rect x="3" y="3" width="13" height="9" rx="2.5"/><path d="M12 12 19 20"/><circle cx="19.5" cy="20.5" r="1.3" fill="currentColor"/>',
  convert: '<path d="M4 7h13l-3-3"/><path d="M20 17H7l3 3"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};

export function icon(name: string): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

// ------------------------------------------------------------ modal

export interface ModalButton<T> {
  label: string;
  value: T;
  kind?: "primary" | "danger" | "plain";
}

let modalOpen = 0;
export function isModalOpen() {
  return modalOpen > 0;
}

export function modal<T>(opts: {
  title: string;
  body?: Node | string;
  buttons: ModalButton<T>[];
  cancelValue: T;
  wide?: boolean;
  onOpen?: (close: (v: T) => void) => void;
}): Promise<T> {
  return new Promise((resolve) => {
    modalOpen++;
    const close = (v: T) => {
      modalOpen--;
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const buttons = opts.buttons.map((b) =>
      h("button", { class: `btn ${b.kind ?? "plain"}`, onclick: () => close(b.value) }, b.label),
    );
    const dialog = h(
      "div",
      { class: `modal${opts.wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": opts.title },
      h("h2", {}, opts.title),
      typeof opts.body === "string" ? h("p", {}, opts.body) : opts.body ?? null,
      h("div", { class: "modal-buttons" }, ...buttons),
    );
    const backdrop = h("div", { class: "backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close(opts.cancelValue) }, dialog);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(opts.cancelValue);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = opts.buttons.find((b) => b.kind === "primary");
        if (primary && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          close(primary.value);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    const primaryBtn = buttons[opts.buttons.findIndex((b) => b.kind === "primary")] ?? buttons[buttons.length - 1];
    primaryBtn?.focus();
    opts.onOpen?.(close);
  });
}

// ------------------------------------------------------------ dropdown menus

export interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  submenu?: MenuItem[];
  separator?: boolean;
}

let activeMenu: HTMLElement | null = null;
export function closeMenus() {
  activeMenu?.remove();
  activeMenu = null;
}

export function openMenu(items: MenuItem[], x: number, y: number) {
  closeMenus();
  const menu = buildMenu(items);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  activeMenu = menu;
  (menu.querySelector("button:not([disabled])") as HTMLElement | null)?.focus();
}

/** Show any element as a dropdown that closes like a menu (outside click, Escape, closeMenus()). */
export function showPopover(panel: HTMLElement, x: number, y: number) {
  closeMenus();
  document.body.append(panel);
  const r = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  panel.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  activeMenu = panel;
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenus();
    }
  });
}

function buildMenu(items: MenuItem[]): HTMLElement {
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.separator) {
      menu.append(h("div", { class: "menu-sep" }));
      continue;
    }
    const btn = h(
      "button",
      { class: "menu-item", role: "menuitem", disabled: item.disabled },
      h("span", { class: "menu-label" }, item.label),
      item.shortcut ? h("span", { class: "menu-shortcut" }, item.shortcut) : item.submenu ? h("span", { class: "menu-shortcut" }, "›") : null,
    );
    if (item.submenu) {
      const wrap = h("div", { class: "menu-sub-wrap" }, btn);
      const sub = buildMenu(item.submenu);
      sub.classList.add("submenu");
      wrap.append(sub);
      menu.append(wrap);
    } else {
      btn.addEventListener("click", () => {
        closeMenus();
        item.action?.();
      });
      menu.append(btn);
    }
  }
  menu.addEventListener("keydown", (e) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>(":scope > button:not([disabled]), :scope > .menu-sub-wrap > button")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === "Escape") closeMenus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  return menu;
}

document.addEventListener("mousedown", (e) => {
  if (activeMenu && !activeMenu.contains(e.target as Node)) closeMenus();
});

// ------------------------------------------------------------ toasts

export interface ToastOptions {
  /** A second, quieter line, e.g. a folder path. Long text is cut at the start. */
  detail?: string;
  /** Buttons in the toast. */
  actions?: { label: string; run: () => void }[];
}

export function toast(message: string, kind: "info" | "error" = "info", opts: ToastOptions = {}) {
  let host = document.querySelector(".toasts");
  if (!host) {
    host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const text = h("div", { class: "toast-text" }, h("div", {}, message), opts.detail ? h("div", { class: "toast-detail" }, h("bdi", {}, opts.detail)) : null);
  const actions = opts.actions ?? [];
  const el = h("div", { class: `toast ${kind}${actions.length ? " has-action" : ""}` }, text);
  for (const { run, label } of actions) {
    el.append(h("button", { class: "toast-action", onclick: () => { run(); dismiss(); } }, label));
  }
  host.append(el);
  // Toasts with a button stay longer, and don't disappear while the pointer is on them.
  const life = actions.length ? 9000 : kind === "error" ? 6000 : 2800;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 400);
  };
  const arm = () => (timer = window.setTimeout(dismiss, life));
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", arm);
  arm();
}
