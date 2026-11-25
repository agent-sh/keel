// The helper's face and name wherever it speaks: its picture when the owner gave it one (round, in the sizes
// of .k-face), else the sparkle mark every build had; its name from the owner (src/helper/persona.ts).
import { Sparkles } from "lucide-react";
import { useHelper } from "../lib/helper.ts";

export type FaceSize = "rail" | "voice" | "head" | "set";

export function useHelperName(): string {
  return useHelper((s) => s.view?.name ?? "Helper");
}

export function HelperFace({ size, testid = "helper-face" }: { size: FaceSize; testid?: string }) {
  const avatar = useHelper((s) => s.view?.avatar);
  const name = useHelperName();
  return avatar
    ? <img className="k-face" data-size={size} src={avatar.url} alt={name} data-testid={testid} draggable={false} />
    : <Sparkles className="k-face-mark" data-size={size} aria-hidden data-testid={testid} />;
}
