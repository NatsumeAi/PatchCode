export type HexColor = `#${string}`

export interface OklchColor {
  l: number // Lightness 0-1
  c: number // Chroma 0-0.4+
  h: number // Hue 0-360
}

export interface ThemeSeedColors {
  neutral: HexColor
  primary: HexColor
  success: HexColor
  warning: HexColor
  error: HexColor
  info: HexColor
  interactive: HexColor
  diffAdd: HexColor
  diffDelete: HexColor
}

export interface ThemePaletteColors {
  neutral: HexColor
  ink: HexColor
  primary: HexColor
  success: HexColor
  warning: HexColor
  error: HexColor
  info: HexColor
  accent?: HexColor
  interactive?: HexColor
  diffAdd?: HexColor
  diffDelete?: HexColor
}

type ThemeVariantBase = {
  overrides?: Record<string, ColorValue>
  kitOverrides?: Record<string, KitColorValue>
  /** @deprecated Prefer `kitOverrides`. Still read one-way by `resolveKitThemeVariant`. */
  v2Overrides?: Record<string, KitColorValue>
}

export type ThemeVariant =
  | ({ seeds: ThemeSeedColors; palette?: never } & ThemeVariantBase)
  | ({ palette: ThemePaletteColors; seeds?: never } & ThemeVariantBase)

export interface DesktopTheme {
  $schema?: string
  name: string
  id: string
  light: ThemeVariant
  dark: ThemeVariant
}

export type TokenCategory =
  | "background"
  | "surface"
  | "text"
  | "border"
  | "icon"
  | "input"
  | "button"
  | "syntax"
  | "markdown"
  | "diff"
  | "avatar"

export type ThemeToken = string

export type CssVarRef = `var(--${string})`

export type ColorValue = HexColor | CssVarRef

export type KitColorValue = HexColor | CssVarRef | string

export type ResolvedTheme = Record<ThemeToken, ColorValue>

export type ResolvedKitTheme = Record<string, KitColorValue>
