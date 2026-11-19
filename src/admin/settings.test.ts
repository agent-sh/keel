// A settings file that cannot be read keeps its bytes: saving is refused until
// it is reset (moved aside), so one edit never erases the owner's other sections.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, patchSettings, registerSettings, resetSettings, settings } from "./settings.ts";

registerSettings("t_archive", { days: 30 }, () => undefined);
registerSettings("t_display", { width: 80 }, () => undefined);

test("an unreadable settings file is not replaced by a save", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-settings-"));
  try {
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"t_archive": {"days": 90}}');
    loadSettings(dir, () => {});
    expect(patchSettings({ t_display: { width: 100 } }).ok).toBe(true);
    expect(settings().t_archive.days).toBe(90);

    const broken = '{"t_archive": {"days": 90},';
    writeFileSync(file, broken);
    const errs: unknown[] = [];
    loadSettings(dir, (e) => errs.push(e));
    expect(errs.length).toBe(1);
    const r = patchSettings({ t_display: { width: 120 } });
    expect(r.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(broken);

    const moved = resetSettings().moved_to!;
    expect(readFileSync(moved, "utf8")).toBe(broken);
    expect(existsSync(file)).toBe(false);
    expect(patchSettings({ t_display: { width: 120 } }).ok).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
