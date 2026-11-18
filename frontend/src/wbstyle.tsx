import { AppGlyph } from "./ui";
import { COLORS, ICONS, iconShape } from "./glyphs";

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
        <div className="wb-swatches" role="radiogroup" aria-label="颜色">
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
          ["通用", ICONS.filter((i) => !i.group)],
          ["常见中间件", ICONS.filter((i) => i.group)],
        ].map(([title, list]) => (
          <div key={title as string}>
            <div className="wb-icons-title">{title as string}</div>
            <div
              className="wb-icons"
              role="radiogroup"
              aria-label={`${title as string}图标`}
            >
              {(list as typeof ICONS).map((i) => (
                <button
                  type="button"
                  key={i.id}
                  role="radio"
                  aria-checked={icon === i.id}
                  aria-label={i.label}
                  title={i.label}
                  className={icon === i.id ? "on" : ""}
                  onClick={() => onChange(i.id, cur.color)}
                >
                  <svg viewBox="0 0 40 40" width="26" height="26" aria-hidden>
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
