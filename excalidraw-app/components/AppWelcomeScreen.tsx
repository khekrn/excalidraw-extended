import { presentationIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { WelcomeScreen } from "@excalidraw/excalidraw/index";
import React from "react";

import { useAtomValue } from "../app-jotai";
import { currentPageAtom, workspaceInfoAtom } from "../workspace/workspace";

const sparkleIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 2.5l1.6 6.1 6.1-1.9-4.4 4.6 4.4 4.6-6.1-1.9L12 20.1l-1.6-6.1-6.1 1.9 4.4-4.6-4.4-4.6 6.1 1.9z"
    />
  </svg>
);

export const AppWelcomeScreen: React.FC<{
  onCollabDialogOpen: () => any;
  isCollabEnabled: boolean;
  onAskClaude: () => void;
  onOpenSlides: () => void;
}> = React.memo((props) => {
  const { t } = useI18n();
  const workspaceInfo = useAtomValue(workspaceInfoAtom);
  const currentPage = useAtomValue(currentPageAtom);

  const headingContent =
    workspaceInfo && currentPage ? (
      <>
        {workspaceInfo.isGoogleDrive
          ? "This page saves automatically and is backed up by Google Drive"
          : "This page saves automatically to"}
        <br />
        {workspaceInfo.isGoogleDrive
          ? `(${workspaceInfo.label.replace(/^Google Drive · /, "")})`
          : workspaceInfo.label}
      </>
    ) : (
      <>
        {t("welcomeScreen.app.center_heading")}
        <br />
        {t("welcomeScreen.app.center_heading_line2")}
        <br />
        {t("welcomeScreen.app.center_heading_line3")}
      </>
    );

  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo />
        <WelcomeScreen.Center.Heading>
          {headingContent}
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          {workspaceInfo?.ai.available && (
            <WelcomeScreen.Center.MenuItem
              onSelect={props.onAskClaude}
              icon={sparkleIcon}
              shortcut={null}
            >
              Ask Claude to draw…
            </WelcomeScreen.Center.MenuItem>
          )}
          <WelcomeScreen.Center.MenuItem
            onSelect={props.onOpenSlides}
            icon={presentationIcon}
            shortcut={null}
          >
            Slides & presenting
          </WelcomeScreen.Center.MenuItem>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />
          {props.isCollabEnabled && (
            <WelcomeScreen.Center.MenuItemLiveCollaborationTrigger
              onSelect={() => props.onCollabDialogOpen()}
            />
          )}
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
