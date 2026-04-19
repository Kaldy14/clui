import type { ProjectPrompt } from "@clui/contracts";
import { ChevronDownIcon, MessageSquareTextIcon, PlusIcon, SettingsIcon } from "lucide-react";
import React, { type FormEvent, useCallback, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Group, GroupSeparator } from "./ui/group";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Textarea } from "./ui/textarea";

export interface NewProjectPromptInput {
  name: string;
  prompt: string;
}

interface ProjectPromptsControlProps {
  prompts: ProjectPrompt[];
  preferredPromptId?: string | null;
  disabled?: boolean;
  onRunPrompt: (prompt: ProjectPrompt) => void;
  onAddPrompt: (input: NewProjectPromptInput) => Promise<void> | void;
  onUpdatePrompt: (promptId: string, input: NewProjectPromptInput) => Promise<void> | void;
  onDeletePrompt: (promptId: string) => Promise<void> | void;
}

export default function ProjectPromptsControl({
  prompts,
  preferredPromptId = null,
  disabled = false,
  onRunPrompt,
  onAddPrompt,
  onUpdatePrompt,
  onDeletePrompt,
}: ProjectPromptsControlProps) {
  const promptFormId = React.useId();
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const primaryPrompt = useMemo(() => {
    if (preferredPromptId) {
      const preferred = prompts.find((entry) => entry.id === preferredPromptId);
      if (preferred) return preferred;
    }
    return prompts[0] ?? null;
  }, [preferredPromptId, prompts]);
  const isEditing = editingPromptId !== null;
  const dropdownItemClassName =
    "data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:hover:bg-accent data-highlighted:hover:text-accent-foreground data-highlighted:focus-visible:bg-accent data-highlighted:focus-visible:text-accent-foreground";

  const submitPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedPrompt.length === 0) {
      setValidationError("Prompt is required.");
      return;
    }

    setValidationError(null);
    try {
      const payload = { name: trimmedName, prompt: trimmedPrompt } satisfies NewProjectPromptInput;
      if (editingPromptId) {
        await onUpdatePrompt(editingPromptId, payload);
      } else {
        await onAddPrompt(payload);
      }
      setDialogOpen(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save prompt.");
    }
  };

  const openAddDialog = () => {
    setEditingPromptId(null);
    setName("");
    setPrompt("");
    setValidationError(null);
    setDialogOpen(true);
  };

  const openEditDialog = (projectPrompt: ProjectPrompt) => {
    setEditingPromptId(projectPrompt.id);
    setName(projectPrompt.name);
    setPrompt(projectPrompt.prompt);
    setValidationError(null);
    setDialogOpen(true);
  };

  const confirmDeletePrompt = useCallback(() => {
    if (!editingPromptId) return;
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
    void onDeletePrompt(editingPromptId);
  }, [editingPromptId, onDeletePrompt]);

  return (
    <>
      {primaryPrompt ? (
        <Group aria-label="Project prompts">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onRunPrompt(primaryPrompt)}
            title={disabled ? "Resume the thread to use prompts" : `Run ${primaryPrompt.name}`}
          >
            <MessageSquareTextIcon className="size-3.5" />
            <span className="ml-0.5">{primaryPrompt.name}</span>
          </Button>
          <GroupSeparator />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger render={<Button size="icon-xs" variant="outline" aria-label="Prompt actions" />}>
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {prompts.map((projectPrompt) => (
                <MenuItem
                  key={projectPrompt.id}
                  className={`group ${dropdownItemClassName}`}
                  onClick={() => {
                    if (disabled) return;
                    onRunPrompt(projectPrompt);
                  }}
                >
                  <MessageSquareTextIcon className="size-4" />
                  <span className="truncate">{projectPrompt.name}</span>
                  <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                      aria-label={`Edit ${projectPrompt.name}`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openEditDialog(projectPrompt);
                      }}
                    >
                      <SettingsIcon className="size-3.5" />
                    </Button>
                  </span>
                </MenuItem>
              ))}
              <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                Add prompt
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : (
        <Button size="xs" variant="outline" onClick={openAddDialog} title="Add prompt">
          <PlusIcon className="size-3.5" />
          <span className="ml-0.5">Add prompt</span>
        </Button>
      )}

      <Dialog
        onOpenChange={setDialogOpen}
        onOpenChangeComplete={(open) => {
          if (open) return;
          setEditingPromptId(null);
          setName("");
          setPrompt("");
          setValidationError(null);
        }}
        open={dialogOpen}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Prompt" : "Add Prompt"}</DialogTitle>
            <DialogDescription>
              Prompts are project-scoped snippets you can send straight from the thread toolbar.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={promptFormId} className="space-y-4" onSubmit={submitPrompt}>
              <div className="space-y-1.5">
                <Label htmlFor="project-prompt-name">Name</Label>
                <Input
                  id="project-prompt-name"
                  placeholder="Code review"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-prompt-body">Prompt</Label>
                <Textarea
                  id="project-prompt-body"
                  placeholder="Review the current changes for bugs, missing tests, and risky edge cases."
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </div>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter>
            {isEditing && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button form={promptFormId} type="submit">
              {isEditing ? "Save changes" : "Save prompt"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete prompt "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This prompt cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeletePrompt}>
              Delete prompt
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
