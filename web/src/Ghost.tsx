import { tokens } from "@fluentui/react-components";

/** Small Spectre mark: a flat ghost in the theme's brand colour. */
export function Ghost({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Spectre">
      <path
        d="M12 2C7.6 2 4.5 5.3 4.5 9.6V21l2.6-2 2.4 2 2.5-2 2.5 2 2.4-2 2.6 2V9.6C19.5 5.3 16.4 2 12 2Z"
        fill={tokens.colorBrandBackground}
      />
      <circle cx="9.2" cy="10" r="1.5" fill={tokens.colorNeutralForegroundOnBrand} />
      <circle cx="14.8" cy="10" r="1.5" fill={tokens.colorNeutralForegroundOnBrand} />
    </svg>
  );
}
