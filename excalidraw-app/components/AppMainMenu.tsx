import {
  eyeIcon,
  LoadIcon,
  presentationIcon,
  ExportIcon,
} from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { sidebarToggleIcon } from "../workspace/WorkspacePanel";

import { saveDebugState } from "./DebugCanvas";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
  isWorkspaceEnabled: boolean;
  onImportAsPage: () => void;
  onToggleWorkspace: () => void;
  onPresent: () => void;
  onExportPdf: () => void;
}> = React.memo((props) => {
  return (
    <MainMenu>
      {props.isWorkspaceEnabled ? (
        <>
          <MainMenu.Item
            icon={sidebarToggleIcon}
            onSelect={props.onToggleWorkspace}
            shortcut="⌘\"
          >
            Pages
          </MainMenu.Item>
          <MainMenu.Item icon={LoadIcon} onSelect={props.onImportAsPage}>
            Import as page (Word, Markdown…)
          </MainMenu.Item>
        </>
      ) : (
        <MainMenu.DefaultItems.LoadScene />
      )}
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.Item icon={ExportIcon} onSelect={props.onExportPdf}>
        Export to PDF
      </MainMenu.Item>
      <MainMenu.Item icon={presentationIcon} onSelect={props.onPresent}>
        Present slides
      </MainMenu.Item>
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      {isDevEnv() && (
        <>
          <MainMenu.Separator />
          <MainMenu.Item
            icon={eyeIcon}
            onSelect={() => {
              if (window.visualDebug) {
                delete window.visualDebug;
                saveDebugState({ enabled: false });
              } else {
                window.visualDebug = { data: [] };
                saveDebugState({ enabled: true });
              }
              props?.refresh();
            }}
          >
            Visual Debug
          </MainMenu.Item>
        </>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
});
