import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/kit/icon"
import "./session-review.css"

export function SessionReviewEmptyChanges() {
  const i18n = useI18n()

  return (
    <div data-slot="session-review-kit-empty-changes">
      <Icon name="review" size="large" />
      <div data-slot="session-review-kit-empty-changes-title">{i18n.t("ui.sessionReview.empty.changes.title")}</div>
      <div data-slot="session-review-kit-empty-changes-description">
        {i18n.t("ui.sessionReview.empty.changes.description")}
      </div>
    </div>
  )
}
