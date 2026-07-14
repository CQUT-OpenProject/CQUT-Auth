import React, { createContext, useContext, useState, useEffect } from "react";
import type { Project } from "../api/types";
import { request } from "../api/client";
import { setActiveProjectForAccessControl } from "../app/providers/access-control-provider";

interface ProjectContextType {
  projects: Project[];
  activeProject: Project | null;
  loading: boolean;
  refreshProjects: () => Promise<void>;
  selectProject: (projectId: string) => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProjects = async () => {
    setLoading(true);
    try {
      const data = await request<{ projects: Project[] }>("/projects");
      setProjects(data.projects);

      // Auto-select or refresh active project
      if (activeProject) {
        const updated = data.projects.find(
          (p) => p.projectId === activeProject.projectId,
        );
        if (updated) {
          setActiveProject(updated);
          setActiveProjectForAccessControl(updated);
        } else if (data.projects.length > 0) {
          setActiveProject(data.projects[0]!);
          setActiveProjectForAccessControl(data.projects[0]!);
        } else {
          setActiveProject(null);
          setActiveProjectForAccessControl(null);
        }
      } else if (data.projects.length > 0) {
        setActiveProject(data.projects[0]!);
        setActiveProjectForAccessControl(data.projects[0]!);
      }
    } catch (error) {
      console.error("Failed to fetch projects:", error);
    } finally {
      setLoading(false);
    }
  };

  const selectProject = (projectId: string) => {
    const project = projects.find((p) => p.projectId === projectId) ?? null;
    setActiveProject(project);
    setActiveProjectForAccessControl(project);
  };

  useEffect(() => {
    refreshProjects();
  }, []);

  return (
    <ProjectContext.Provider
      value={{
        projects,
        activeProject,
        loading,
        refreshProjects,
        selectProject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return context;
};
