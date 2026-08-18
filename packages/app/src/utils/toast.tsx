import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Toast, showToast as showLegacyToast, type ToastOptions, type ToastVariant } from "@opencode-ai/ui/toast"
import { Toast as KitToast, showToast as showKitToast } from "@opencode-ai/ui/kit/toast"

let kit = false

export function setKitToast(value: boolean) {
  kit = value
}

export function ToastRegion(props: { kit: boolean }) {
  if (props.kit) return <KitToast.Region />
  return <Toast.Region />
}

export function showToast(options: ToastOptions | string) {
  if (!kit) return showLegacyToast(options)
  if (typeof options === "string") return showKitToast(options)

  return showKitToast({
    ...options,
    icon: resolveIcon(options.icon, options.variant),
    actions: options.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

function resolveIcon(icon: IconProps["name"] | undefined, variant: ToastVariant | undefined) {
  const name = icon ?? (variant === "success" ? "check" : undefined)
  if (!name) return
  return <Icon name={name} />
}
