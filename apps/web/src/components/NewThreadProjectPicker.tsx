import type { ProjectId } from "@clui/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useNewThreadHandler } from "../hooks/useNewThreadHandler";
import { requestProjectAdd } from "../lib/projectAddRequest";
import { useStore } from "../store";
import type { Project } from "../types";
import { prioritizeActiveProject } from "./NewThreadView.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";

export function NewThreadProjectPicker({ activeProject }: { activeProject: Project | null }) {
  const projects = useStore((state) => state.projects);
  const handleNewThread = useNewThreadHandler();
  const orderedProjects = useMemo(
    () => (activeProject ? prioritizeActiveProject(projects, activeProject.id) : projects),
    [activeProject, projects],
  );

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );

  const canChooseProject = orderedProjects.length > 0;
  const selector = canChooseProject ? (
    <Menu>
      <MenuTrigger
        aria-label={activeProject ? "Change project" : "Choose a project"}
        className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-foreground underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {activeProject?.name ?? "Choose a project"}
      </MenuTrigger>
      <MenuPopup align="center" className="max-h-80 w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProject?.id ?? ""}
          onValueChange={(value) => {
            const project = projectById.get(value as ProjectId);
            if (!project || project.id === activeProject?.id) return;
            void handleNewThread(project.id, {
              replace: true,
              reuseExistingDraft: true,
            });
          }}
        >
          {orderedProjects.map((project) => (
            <MenuRadioItem key={project.id} value={project.id} closeOnClick>
              <span className="min-w-0 truncate">{project.name}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={requestProjectAdd}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={requestProjectAdd}
      className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-muted-foreground/60 underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      Add a project
    </button>
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
      {activeProject ? (
        <>What should we build in {selector}?</>
      ) : canChooseProject ? (
        <>{selector} to start</>
      ) : (
        <>{selector} to start</>
      )}
    </h1>
  );
}
