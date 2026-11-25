import { Copy } from "lucide-react";
import { useRef } from "react";
import { Button } from "./button.tsx";
import { Field, Input } from "./field.tsx";
import { useToast } from "./toast.tsx";

/** A key or a link shown once, to copy; where the clipboard refuses, it is selected for the keyboard. */
export function Secret({ label, value, help }: { label: string; value: string; help?: string }) {
  const field = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ text: `Copied the ${label.toLowerCase()}` });
    } catch {
      field.current?.select();
      toast({ kind: "info", text: "It is selected: press ⌘C or Ctrl+C to copy it" });
    }
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={label}>
            <Input ref={field} mono readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
          </Field>
        </div>
        <Button icon={Copy} onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}
