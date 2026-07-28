import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";

export interface NewThreadChoice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly icon?: ReactNode;
}

export function NewThreadChoiceMenu<Value extends string>({
  ariaLabel,
  value,
  label,
  icon,
  options,
  onValueChange,
  className,
  disabled = false,
  compact = false,
}: {
  ariaLabel: string;
  value: Value;
  label: string;
  icon: ReactNode;
  options: readonly NewThreadChoice<Value>[];
  onValueChange: (value: Value) => void;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size={compact ? "xs" : "sm"}
            variant="ghost"
            aria-label={ariaLabel}
            disabled={disabled}
            className={cn(
              "shrink-0 gap-2 px-2 text-muted-foreground hover:text-foreground",
              compact ? "h-7 sm:h-6" : "h-8 sm:h-7",
              className,
            )}
          />
        }
      >
        {icon}
        <span className="max-w-36 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 opacity-55" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-44">
        <MenuRadioGroup
          value={value}
          onValueChange={(nextValue) => {
            if (typeof nextValue !== "string") return;
            const option = options.find((candidate) => candidate.value === nextValue);
            if (option && option.value !== value) onValueChange(option.value);
          }}
        >
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                {option.icon ? (
                  <span aria-hidden="true" className="flex shrink-0">
                    {option.icon}
                  </span>
                ) : null}
                <span className="truncate">{option.label}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

export function NewThreadToggleControl({
  checked,
  label,
  ariaLabel,
  icon,
  tone = "default",
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  ariaLabel: string;
  icon: ReactNode;
  tone?: "default" | "danger";
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      size="sm"
      variant="ghost"
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "h-8 shrink-0 gap-2 px-2 text-muted-foreground sm:h-7",
        tone === "danger" && checked
          ? "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
          : checked
            ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            : "hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}
