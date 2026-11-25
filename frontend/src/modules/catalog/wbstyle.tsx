import { AppGlyph } from "../../design/ui";
import { COLORS, ICONS, iconShape } from "../../design/glyphs";
import { bi, useLang } from "../../app/i18n";

/** Choose a component's logo and tint, with the result drawn as it will look in the lists. */
export function StylePicker({
  id,
  category,
  icon,
  color,
  onChange,
}: {
  id: string;
  category?: string;
  icon?: string;
  color?: string;
  onChange: (icon: string, color: string) => void;
}) {
  useLang();
  const cur = { icon: icon || "", color: color || "" };
  return (
    <div className="wb-style">
      <div className="wb-style-preview" aria-hidden>
        <AppGlyph
          id={`pick-${id}`}
          category={category}
          icon={icon}
          color={color}
          size={64}
        />
        <AppGlyph
          id={`pick-${id}`}
          category={category}
          icon={icon}
          color={color}
          size={32}
        />
        <AppGlyph
          id={`pick-${id}`}
          category={category}
          icon={icon}
          color={color}
          size={18}
        />
      </div>
      <div className="wb-style-pick">
        <div className="wb-swatches" role="radiogroup" aria-label={bi("颜色", "Color")}>
          {COLORS.map((c) => (
            <button
              type="button"
              key={c.id}
              role="radio"
              aria-checked={color === c.id}
              aria-label={c.label}
              title={c.label}
              className={color === c.id ? "on" : ""}
              style={{ background: `linear-gradient(${c.tile.join(",")})` }}
              onClick={() => onChange(cur.icon, c.id)}
            />
          ))}
        </div>
        {[
          { key: "middleware", title: bi("常见中间件", "Common Middleware"), list: ICONS.filter((i) => i.group) },
          { key: "general", title: bi("通用", "General"), list: ICONS.filter((i) => !i.group) },
        ].map(({ key, title, list }) => (
          <div key={key}>
            <div className="wb-icons-title">{title}</div>
            <div
              className="wb-icons"
              role="radiogroup"
              aria-label={bi(`${title}图标`, `${title} icons`)}
            >
              {list.map((i) => (
                <button
                  type="button"
                  key={i.id}
                  role="radio"
                  aria-checked={icon === i.id}
                  aria-label={i.label}
                  title={i.label}
                  className={`${icon === i.id ? "on" : ""} ${i.group === "middleware" ? "is-brand" : ""}`.trim()}
                  onClick={() => onChange(i.id, cur.color)}
                >
                  <svg
                    viewBox="0 0 40 40"
                    width={i.group === "middleware" ? 34 : 28}
                    height={i.group === "middleware" ? 34 : 28}
                    aria-hidden
                  >
                    {iconShape(i.id)}
                  </svg>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
