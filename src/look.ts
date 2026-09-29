/**
 * The chat's ready-made LOOKS (`open({ look })`, `chat.setStyle({ look })`) — full token sets,
 * each with a day and a night side, shaped like the UI kit a host app is built with. `theme`
 * keeps its meaning (the colour MODE: light | dark | auto); `look` is the kit, and the `accent`
 * hue sits on top of any look.
 *
 * `phosphor` is confiqure's own look and the default. The same five names are the dashboard's
 * stored `widgetTheme` (backend WidgetLook.java) and the chat widget's own check
 * (confiqure.ai: frontend/app/utils/widgetTheme.ts, `isWidgetLook`) — keep the three in step.
 */
export const LOOKS = ['phosphor', 'tairo', 'shadcn', 'material', 'bootstrap'] as const

export type ConfiqureLook = typeof LOOKS[number]

export function isLook(v: unknown): v is ConfiqureLook {
  return typeof v === 'string' && (LOOKS as readonly string[]).includes(v)
}
