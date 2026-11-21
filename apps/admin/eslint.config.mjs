import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // biến bắt đầu bằng _ là cố ý bỏ qua (vd tách field `resolved` khỏi block)
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      // nạp dữ liệu từ React Query vào state form khi tải xong là mẫu có chủ đích
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // bộ sinh form động của Page Builder làm việc với dữ liệu block tuỳ ý
    files: ["src/components/builder/fields.tsx", "src/hooks/use-settings.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
