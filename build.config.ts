import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts"],
      outDir: "./dist",
      minify: false,
      dts: true,
    },
  ],
});
