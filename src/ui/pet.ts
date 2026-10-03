import petSvgUrl from "../../assets/brand/xiaoji-pet.svg";

type PetState = "idle" | "blink" | "look" | "doze" | "walk" | "hop" | "celebrate";

function petArtwork(): SVGSVGElement {
  const separator = petSvgUrl.indexOf(",");
  if (separator < 0) throw new Error("小记矢量资源无效");
  const encoded = petSvgUrl.slice(separator + 1);
  const svg = new DOMParser().parseFromString(decodeURIComponent(encoded), "image/svg+xml").documentElement;
  if (svg.localName !== "svg") throw new Error("小记矢量资源无法解析");
  const element = document.importNode(svg, true) as unknown as SVGSVGElement;
  element.classList.add("agentnote-pet-art");
  element.setAttribute("aria-hidden", "true");
  return element;
}

export class CompanionPet {
  readonly element: HTMLButtonElement;
  private readonly traveler: HTMLSpanElement;
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly observer: IntersectionObserver;
  private timer: number | null = null;
  private frame: number | null = null;
  private intersecting = false;
  private state: PetState = "idle";
  private disposed = false;
  private position = 28;
  private lastCelebrate = 0;

  constructor() {
    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.className = "agentnote-pet";
    this.element.setAttribute("aria-label", "和小记互动");
    this.element.title = "点一下小记";
    this.element.dataset.state = "idle";
    this.traveler = document.createElement("span");
    this.traveler.className = "agentnote-pet-traveler";
    this.traveler.style.transform = `translateX(${this.position}px)`;
    this.traveler.append(petArtwork());
    this.element.append(this.traveler);
    this.element.addEventListener("click", () => this.perform("hop"));
    this.element.addEventListener("pointerenter", () => { if (this.state === "idle") this.perform("look"); });
    this.observer = new IntersectionObserver(([entry]) => {
      this.intersecting = entry.isIntersecting;
      this.syncVisibility();
    });
    this.observer.observe(this.element);
    document.addEventListener("visibilitychange", this.syncVisibility);
    this.motion.addEventListener("change", this.syncVisibility);
  }

  mount(parent: HTMLElement): void { parent.append(this.element); }

  celebrate(): void {
    if (Date.now() - this.lastCelebrate < 2_000) return;
    if (this.perform("celebrate")) this.lastCelebrate = Date.now();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.syncVisibility);
    this.motion.removeEventListener("change", this.syncVisibility);
    this.element.remove();
  }

  /** Also used by the independent motion preview. */
  perform(action: "blink" | "look" | "doze" | "walk" | "hop" | "celebrate"): boolean {
    if (this.disposed || !this.intersecting || document.hidden || this.motion.matches) return false;
    if (action === "walk") { this.walk(); return true; }
    this.freezeWalk();
    this.clearTimers();
    this.setState(action);
    const duration = { blink: 220, look: 1250, doze: 2100, hop: 1120, celebrate: 1350 }[action];
    this.timer = window.setTimeout(() => this.finish(), duration);
    return true;
  }

  private readonly syncVisibility = (): void => {
    if (this.disposed) return;
    const active = this.intersecting && !document.hidden && !this.motion.matches;
    this.element.classList.toggle("is-paused", !active);
    if (!active) {
      this.freezeWalk();
      this.clearTimers();
      this.setState("idle");
      return;
    }
    if (this.state === "idle" && this.timer === null) this.scheduleAmbient();
  };

  private setState(state: PetState): void {
    this.state = state;
    this.element.dataset.state = state;
  }

  private clearTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.timer = null;
    this.frame = null;
  }

  private scheduleAmbient(): void {
    if (!this.intersecting || document.hidden || this.motion.matches) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const choice = Math.random();
      if (choice < 0.32) this.perform("walk");
      else if (choice < 0.54) this.perform("doze");
      else if (choice < 0.78) this.perform("look");
      else this.perform("blink");
    }, 6_000 + Math.random() * 8_000);
  }

  private finish(): void {
    this.timer = null;
    this.setState("idle");
    this.scheduleAmbient();
  }

  private freezeWalk(): void {
    if (this.state !== "walk") return;
    const matrix = new DOMMatrixReadOnly(window.getComputedStyle(this.traveler).transform);
    this.position = matrix.m41;
    this.traveler.style.transform = `translateX(${this.position}px)`;
  }

  private walk(): void {
    this.freezeWalk();
    this.clearTimers();
    this.setState("walk");
    this.position = this.position < 14 ? 28 : 0;
    this.element.classList.toggle("faces-left", this.position === 0);
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.traveler.style.transform = `translateX(${this.position}px)`;
    });
    this.timer = window.setTimeout(() => this.finish(), 2350);
  }
}
