/**
 * Nextra 2.13.4 validates page meta and the docs theme with Zod 3 helpers that
 * Zod 4 removed (`.deepPartial()` and `ZodFunction.returns()`). The installed
 * `zod` package is overridden to 4.6.7 for GHSA-mrhx-c7xc-m3w5, so rewrite those
 * call sites onto the patched Zod 4 API before Next compiles Nextra.
 *
 * Idempotent: a fresh install rewrites node_modules; a second run leaves the
 * already-patched files alone.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function helperSource(binding) {
  return `function deepPartial(schema) {
  const type = schema?.def?.type;
  if (type === "object") {
    const shape = {};
    for (const [key, child] of Object.entries(schema.shape)) {
      const inner = deepPartial(child);
      shape[key] = inner?.def?.type === "optional" ? inner : inner.optional();
    }
    return schema.def.catchall?.def?.type === "never"
      ? ${binding}.strictObject(shape)
      : ${binding}.object(shape);
  }
  if (type === "array") {
    return ${binding}.array(deepPartial(schema.element));
  }
  if (type === "union") {
    return ${binding}.union(schema.options.map((option) => deepPartial(option)));
  }
  if (type === "optional") {
    return deepPartial(schema.def.innerType).optional();
  }
  return schema;
}
`;
}

function assertZod4HelperWorks() {
  const { z } = require("zod");
  if (!z.function().output) {
    throw new Error("Expected zod 4 ZodFunction.output (patched zod did not load)");
  }
  const deepPartial = new Function(
    "z",
    `${helperSource("z")}\nreturn deepPartial;`
  )(z);

  const item = deepPartial(
    z
      .strictObject({
        href: z.string(),
        newWindow: z.boolean(),
        title: z.string(),
      })
      .extend({
        display: z.enum(["normal", "hidden", "children"]),
        theme: z.strictObject({
          breadcrumb: z.boolean(),
          layout: z.enum(["default", "full", "raw"]),
        }),
        type: z.enum(["page", "doc"]),
      })
  );
  item.parse({});
  item.parse({ title: "T", theme: { breadcrumb: true } });
  let rejected = false;
  try {
    item.parse({ extra: true });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("deepPartial lost strict-object key checking");
  }

  const theme = z.strictObject({
    search: z.strictObject({
      placeholder: z.string().or(z.function().output(z.string())),
      error: z.string(),
    }),
    i18n: z.array(
      z.strictObject({
        locale: z.string(),
        text: z.string(),
      })
    ),
  });
  const pub = deepPartial(theme).extend({
    i18n: z
      .array(
        z.strictObject({
          locale: z.string(),
          text: z.string(),
        })
      )
      .optional(),
  });
  pub.parse({
    search: { placeholder: "Themen oder Inhalte suchen..." },
    i18n: [{ locale: "de", text: "Deutsch" }],
  });
  pub.parse({});
}

function patchFile(file, mutate) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${file}. Run npm install before this patch.`);
  }
  const original = fs.readFileSync(full, "utf8");
  const next = mutate(original);
  if (next === original) return;
  fs.writeFileSync(full, next);
}

function patchNormalizePages(src) {
  if (src.includes("function deepPartial(schema)") && !src.includes(".deepPartial()")) {
    return src;
  }
  const from = `var itemSchema = linkItemSchema.extend({
  display: displaySchema,
  theme: pageThemeSchema,
  title: titleSchema,
  type: z.enum(["page", "doc"])
}).deepPartial();`;
  const to = `var itemSchema = deepPartial(linkItemSchema.extend({
  display: displaySchema,
  theme: pageThemeSchema,
  title: titleSchema,
  type: z.enum(["page", "doc"])
}));`;
  if (!src.includes(from)) {
    throw new Error(
      "nextra/dist/normalize-pages.js no longer matches the Zod 3 deepPartial call this patch expects"
    );
  }
  if (!src.includes('import { z } from "zod";\n')) {
    throw new Error('nextra/dist/normalize-pages.js is missing import { z } from "zod"');
  }
  return src
    .replace(
      'import { z } from "zod";\n',
      `import { z } from "zod";\n${helperSource("z")}`
    )
    .replace(from, to);
}

function patchTheme(src) {
  const already =
    src.includes("function deepPartial(schema)") &&
    !src.includes(".deepPartial()") &&
    !src.includes("z2.function().returns(");
  if (already) return src;

  let next = src;
  if (!next.includes("function deepPartial(schema)")) {
    const importLine = 'import { z as z2 } from "zod";\n';
    if (!next.includes(importLine)) {
      throw new Error('nextra-theme-docs is missing import { z as z2 } from "zod"');
    }
    next = next.replace(importLine, `${importLine}${helperSource("z2")}`);
  }
  if (next.includes("z2.function().returns(")) {
    next = next.replaceAll("z2.function().returns(", "z2.function().output(");
  } else if (!next.includes("z2.function().output(")) {
    throw new Error("nextra-theme-docs no longer uses z2.function().returns or .output");
  }
  const from = "var publicThemeSchema = themeSchema.deepPartial().extend({";
  const to = "var publicThemeSchema = deepPartial(themeSchema).extend({";
  if (next.includes(from)) {
    next = next.replace(from, to);
  } else if (!next.includes(to)) {
    throw new Error("nextra-theme-docs publicThemeSchema deepPartial call was not found");
  }
  if (next.includes(".deepPartial()") || next.includes("z2.function().returns(")) {
    throw new Error("nextra-theme-docs still contains Zod 3 calls after patching");
  }
  return next;
}

assertZod4HelperWorks();
patchFile("node_modules/nextra/dist/normalize-pages.js", patchNormalizePages);
patchFile("node_modules/nextra-theme-docs/dist/index.js", patchTheme);
