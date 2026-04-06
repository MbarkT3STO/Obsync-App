# Obsync Design System — Token Reference

## Color Layers (Dark Mode)
| Token | Value | Usage |
|---|---|---|
| `--layer-0` | `#08080D` | App background, window chrome |
| `--layer-1` | `#0F0F17` | Sidebar, main panels |
| `--layer-2` | `#16161F` | Cards, config sections |
| `--layer-3` | `#1E1E2A` | Hover states, active cards, modals |
| `--layer-4` | `#252534` | Popovers, dropdowns, toasts |

## Accent
| Token | Value | Usage |
|---|---|---|
| `--accent` | `#7C6AFE` | Primary CTA, active states, progress |
| `--accent-light` | `#A78BFA` | Text on dark, icons |
| `--accent-glow` | `rgba(124,106,254,0.15)` | Accent backgrounds |
| `--accent-grad` | `linear-gradient(135deg, #7C6AFE, #6B5AE0)` | Primary buttons |

## Semantic
| Token | Value |
|---|---|
| `--success` | `#34C759` |
| `--warning` | `#FF9F0A` |
| `--danger` | `#FF453A` |
| `--info` | `#0A84FF` |

## Text Hierarchy
| Token | Value | Usage |
|---|---|---|
| `--text-1` | `rgba(255,255,255,0.92)` | Headings, important labels |
| `--text-2` | `rgba(255,255,255,0.55)` | Body text, descriptions |
| `--text-3` | `rgba(255,255,255,0.30)` | Timestamps, hints, placeholders |
| `--text-4` | `rgba(255,255,255,0.15)` | Disabled, decorative |

## Borders
| Token | Value |
|---|---|
| `--border-subtle` | `rgba(255,255,255,0.05)` |
| `--border-default` | `rgba(255,255,255,0.08)` |
| `--border-emphasis` | `rgba(255,255,255,0.12)` |
| `--border-accent` | `rgba(124,106,254,0.35)` |

## Border Radius
| Token | Value |
|---|---|
| `--r-xs` | `4px` |
| `--r-sm` | `6px` |
| `--r-md` | `8px` |
| `--r-lg` | `12px` |
| `--r-xl` | `14px` |
| `--r-2xl` | `20px` |
| `--r-pill` | `9999px` |

## Easing
| Token | Value | Usage |
|---|---|---|
| `--ease-spring` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | Card hovers, sidebar |
| `--ease-bounce` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Modal entry, button release |
| `--ease-smooth` | `cubic-bezier(0.4, 0, 0.2, 1)` | Status transitions |
| `--ease-sharp` | `cubic-bezier(0.4, 0, 0.6, 1)` | Button press |

## Typography Scale
| Class | Size / Weight | Usage |
|---|---|---|
| `.text-micro` | 10px / 400 | Micro labels |
| `.text-badge` | 11px / 500 | Badges, tags |
| `.text-label` | 11px / 500 uppercase | Section headers |
| `.text-caption` | 12px / 400 | Timestamps, helpers |
| `.text-body` | 13px / 400 | Default body |
| `.text-body-m` | 13px / 500 | Emphasized body |
| `.text-card` | 15px / 500 | Card titles |
| `.text-title` | 17px / 600 | Page titles |
| `.text-hero` | 22px / 700 | Hero numbers |
| `.text-display` | 28px / 700 | Empty state headings |

## Light Mode Overrides
Applied via `[data-theme="light"]` on `<html>` and `body.theme-light`.

| Token | Light Value |
|---|---|
| `--layer-0` | `#F2F2F7` |
| `--layer-1` | `#FFFFFF` |
| `--layer-2` | `#F2F2F7` |
| `--layer-3` | `#E5E5EA` |
| `--layer-4` | `#D1D1D6` |
| `--text-1` | `rgba(0,0,0,0.88)` |
| `--text-2` | `rgba(0,0,0,0.50)` |
| `--text-3` | `rgba(0,0,0,0.28)` |
| `--text-4` | `rgba(0,0,0,0.12)` |
