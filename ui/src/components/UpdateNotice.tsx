import { RotateCw } from "lucide-react";
import { reloadNow, useUiUpdate } from "../lib/hotui.ts";

// A new page was installed while this one had something to keep (text in a box,
// a dialog, a transcript scrolled up): the reload waits for the owner.
export function UpdateNotice() {
  const v = useUiUpdate();
  if (!v) return null;
  return (
    <div role="status" data-testid="ui-update" className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-raised py-1.5 pr-1.5 pl-3.5 text-ui shadow-2">
      <span className="text-muted">Keel's page was updated.</span>
      <button type="button" onClick={reloadNow} data-testid="ui-update-reload" className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover">
        <RotateCw className="size-3.5" /> Reload
      </button>
    </div>
  );
}
