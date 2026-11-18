import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import { presentationIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import { ClaudePanel } from "../ai/ClaudePanel";
import { SlidesPanel } from "../slides/SlidesPanel";

import "./AppSidebar.scss";

export const CLAUDE_SIDEBAR_TAB = "claude";
export const SLIDES_SIDEBAR_TAB = "presentation";

const claudeTabIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 2.5l1.6 6.1 6.1-1.9-4.4 4.6 4.4 4.6-6.1-1.9L12 20.1l-1.6-6.1-6.1 1.9 4.4-4.6-4.4-4.6 6.1 1.9z"
    />
  </svg>
);

export const AppSidebar = () => {
  const { openSidebar } = useUIAppState();

  return (
    <DefaultSidebar>
      <DefaultSidebar.TabTriggers>
        <Sidebar.TabTrigger
          tab={CLAUDE_SIDEBAR_TAB}
          title="Ask Claude"
          style={{ opacity: openSidebar?.tab === CLAUDE_SIDEBAR_TAB ? 1 : 0.5 }}
        >
          {claudeTabIcon}
        </Sidebar.TabTrigger>
        <Sidebar.TabTrigger
          tab={SLIDES_SIDEBAR_TAB}
          title="Slides"
          style={{ opacity: openSidebar?.tab === SLIDES_SIDEBAR_TAB ? 1 : 0.5 }}
        >
          {presentationIcon}
        </Sidebar.TabTrigger>
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab={CLAUDE_SIDEBAR_TAB} className="app-sidebar-tab">
        <ClaudePanel />
      </Sidebar.Tab>
      <Sidebar.Tab tab={SLIDES_SIDEBAR_TAB} className="app-sidebar-tab">
        <SlidesPanel />
      </Sidebar.Tab>
    </DefaultSidebar>
  );
};
