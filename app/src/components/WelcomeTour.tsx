// The welcome window shown the first time the app starts (until it is closed
// once; Settings can show it again).
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../store";

const STEPS = [
  {
    title: "Welcome to Blockwright",
    text: "Make Minecraft Java Edition resource packs: redraw any texture of the game, animate it, see it in 3D, and export a pack that is ready to play.",
    points: [
      ["Every texture", "of the version you play, found on your computer."],
      ["A pixel editor", "with layers, a pack palette and live 3D preview."],
      ["One-click export", "with checks, and copies for older versions."],
    ],
  },
  {
    title: "How it works",
    text: "Three steps from an empty pack to one you can play with.",
    points: [
      ["1 · Create a pack", "Pick the Minecraft version you play and a resolution (16×, 32×, 64×…)."],
      ["2 · Draw or import", "Open a texture from the list, draw over the game’s own, or import your PNGs."],
      ["3 · Export", "Fix what the checks find, then export a .zip or install it straight into the game."],
    ],
  },
  {
    title: "Good to know",
    text: "A few things that make the app easier to use.",
    points: [
      ["Ctrl K", "searches textures, screens and commands from anywhere."],
      ["Your files are safe", "Nothing is written until you save, and replaced textures go to the pack’s history."],
      ["Game textures", "are read from your own game and stay in the app’s cache. They are never put in your pack unless you draw over them."],
    ],
  },
] as const;

export function WelcomeTour() {
  const boot = useApp((s) => s.boot);
  const [step, setStep] = useState(0);
  const [closed, setClosed] = useState(false);
  const open = !!boot && !boot.settings.welcome_seen && !closed;

  const finish = async () => {
    setClosed(true);
    try {
      useApp.getState().setBoot(await api.updateSettings({ welcome_seen: true }));
    } catch (e) {
      useApp.getState().showError(e);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void finish();
      else if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, STEPS.length - 1));
      else if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // shown again from Settings: start from the first page
  useEffect(() => {
    if (boot && !boot.settings.welcome_seen) {
      setClosed(false);
      setStep(0);
    }
  }, [boot?.settings.welcome_seen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  return (
    <div className="scrim welcome-scrim" role="dialog" aria-modal="true" aria-label={s.title}>
      <div className="modal welcome">
        <div className="welcome-hero">
          <img src="/logo.png" alt="" width={64} height={64} className="pixel" draggable={false} />
        </div>
        <h2>{s.title}</h2>
        <p>{s.text}</p>
        <ul className="welcome-points">
          {s.points.map(([head, body]) => (
            <li key={head}><b>{head}</b> <span>{body}</span></li>
          ))}
        </ul>
        <div className="welcome-foot">
          <div className="welcome-dots" aria-label={`Page ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((_, i) => (
              <button key={i} className={i === step ? "on" : ""} aria-label={`Page ${i + 1}`} onClick={() => setStep(i)} />
            ))}
          </div>
          <div className="buttons">
            {!last && <button className="btn md ghost" onClick={() => void finish()}>Skip</button>}
            {step > 0 && <button className="btn md" onClick={() => setStep(step - 1)}>Back</button>}
            <button autoFocus className="btn md primary" onClick={() => (last ? void finish() : setStep(step + 1))}>
              {last ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
