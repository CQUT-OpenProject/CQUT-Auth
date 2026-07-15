import React, { createContext, useContext, useState, useEffect } from "react";
import type { Project } from "../api/types";
import { request } from "../api/client";
import { setActiveProjectForAccessControl } from "../app/providers/access-control-provider";
import { useLocation } from "react-router-dom";

const SYSTEM_PROJECT_ID = "system";

function projectIdFromPath(pathname: string) {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

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
  const location = useLocation();

  const activate = (project: Project | null) => {
    setActiveProject(project);
    setActiveProjectForAccessControl(project);
  };

  const refreshProjects = async () => {
    setLoading(true);
    try {
      const data = await request<{ projects: Project[] }>("/projects");
      setProjects(data.projects);
      const routeProjectId = projectIdFromPath(location.pathname);
      activate(
        data.projects.find((project) => project.projectId === routeProjectId) ??
          data.projects.find(
            (project) => project.projectId === activeProject?.projectId,
          ) ??
          data.projects.find(
            (project) => project.projectId !== SYSTEM_PROJECT_ID,
          ) ??
          null,
      );
    } catch (error) {
      console.error("Failed to fetch projects:", error);
    } finally {
      setLoading(false);
    }
  };

  const selectProject = (projectId: string) => {
    const project = projects.find((p) => p.projectId === projectId) ?? null;
    activate(project);
  };

  useEffect(() => {
    refreshProjects();
  }, []);

  useEffect(() => {
    const routeProjectId = projectIdFromPath(location.pathname);
    if (!routeProjectId || routeProjectId === activeProject?.projectId) return;
    const project = projects.find((item) => item.projectId === routeProjectId);
    if (project) activate(project);
  }, [location.pathname, projects]);

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
