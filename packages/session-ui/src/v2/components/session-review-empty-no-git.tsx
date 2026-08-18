import { FileIcon } from "@opencode-ai/ui/file-icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Button } from "@opencode-ai/ui/kit/button"
import "./session-review.css"

export type SessionReviewEmptyNoGitProps = {
  pending: boolean
  onInitGit: () => void
}

export function SessionReviewEmptyNoGit(props: SessionReviewEmptyNoGitProps) {
  const i18n = useI18n()

  return (
    <div data-slot="session-review-kit-empty-no-git">
      <FileIcon node={{ path: ".gitignore", type: "file" }} mono />
      <div data-slot="session-review-kit-empty-no-git-title">{i18n.t("ui.sessionReview.empty.noGit.title")}</div>
      <div data-slot="session-review-kit-empty-no-git-description">
        {i18n.t("ui.sessionReview.empty.noGit.description")}
      </div>
      <Button variant="neutral" size="normal" disabled={props.pending} onClick={props.onInitGit}>
        {props.pending
          ? i18n.t("ui.sessionReview.empty.noGit.actionLoading")
          : i18n.t("ui.sessionReview.empty.noGit.action")}
      </Button>
    </div>
  )
}
