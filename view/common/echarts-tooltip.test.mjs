// Run from Admin or Supplier. Exercise the installed renderer, not a copied escaper.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve("package.json"));
const root = dirname(require.resolve("echarts/package.json"));
const moduleAt = (path) => import(pathToFileURL(resolve(root, path)).href);
const echarts = await moduleAt("index.js");
const { buildTooltipMarkup, TooltipMarkupStyleCreator } = await moduleAt("lib/component/tooltip/tooltipMarkup.js");
const { normalizeTooltipFormatResult } = await moduleAt("lib/model/mixin/dataFormat.js");
const { default: TooltipHTMLContent } = await moduleAt("lib/component/tooltip/TooltipHTMLContent.js");
const { default: TooltipView } = await moduleAt("lib/component/tooltip/TooltipView.js");
const { encodeHTML, formatTpl } = await moduleAt("lib/util/format.js");
const labels = ["正常名称 & 数值", '<b data-echarts-probe="raw">名称</b>', "&#x3c;b&#x3e;编码名称&#x3c;/b&#x3e;"];

function htmlSink(content) {
  // Only the DOM element is inert. The published innerHTML assignment still runs.
  const el = { innerHTML: "" };
  TooltipHTMLContent.prototype.setContent.call({ el }, content, null, { get: () => null });
  return el.innerHTML;
}

for (const type of ["line", "bar", "pie"]) {
  test(`${type} single/multiple-series fragments render values and escape names at the HTML sink`, () => {
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 320, height: 200 });
    try {
      for (const name of labels) {
        chart.setOption({
          animation: false,
          xAxis: { type: "category", data: [name] }, yAxis: { type: "value" },
          series: [{ type, name, data: [{ name, value: 7 }] }],
        }, true);
        const series = chart.getModel().getSeriesByIndex(0);
        assert.equal(series.subType, type);
        assert.equal(series.getRawValue(0), 7);
        for (const multiple of [false, true]) {
          const result = normalizeTooltipFormatResult(series.formatTooltip(0, multiple, null));
          const content = result.frag
            ? buildTooltipMarkup(result.frag, new TooltipMarkupStyleCreator(), "html", undefined, false, {})
            : result.text;
          const html = htmlSink(content);
          assert.ok(html.includes(encodeHTML(name)), `${type}: name escaped exactly once`);
          assert.ok(!html.includes("<b data-echarts-probe"));
          assert.match(html, />7<\/span>/, `${type}: rendered value remains visible`);
        }
      }
    } finally { chart.dispose(); }
  });
}

test("actual axis-tooltip construction escapes distinct category headers on both axes", () => {
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 320, height: 200 });
  try {
    for (const axisDim of ["x", "y"]) for (const name of labels) {
      const seriesName = "独立系列 & 名称";
      chart.setOption({
        animation: false, tooltip: { trigger: "axis" },
        xAxis: axisDim === "x" ? { type: "category", data: [name] } : { type: "value" },
        yAxis: axisDim === "y" ? { type: "category", data: [name] } : { type: "value" },
        series: [{ type: "bar", name: seriesName, data: [{ name: "独立数据项", value: 7 }] }],
      }, true);
      const ecModel = chart.getModel();
      let html;
      // Run the published axis label/section builder; bypass positioning and use an inert HTML element.
      TooltipView.prototype._showAxisTooltip.call({
        _ecModel: ecModel, _tooltipModel: ecModel.getComponent("tooltip"), _renderMode: "html",
        _showOrMove(_model, callback) { callback.call(this); },
        _updateContentNotChangedOnAxis: () => false,
        _showTooltipContent(_model, content, params) {
          assert.equal(params[0].axisValueLabel, name);
          html = htmlSink(content);
        },
      }, [{ dataByAxis: [{ axisDim, axisIndex: 0, axisType: "category", value: 0, valueLabelOpt: {}, seriesDataIndices: [{ seriesIndex: 0, dataIndexInside: 0 }] }] }], { offsetX: 0, offsetY: 0 });
      assert.ok(html.includes(encodeHTML(name)), "category header is escaped");
      assert.ok(html.includes(encodeHTML(seriesName)), "series and axis labels are independent");
      assert.ok(!html.includes("<b data-echarts-probe"));
      assert.match(html, />7<\/span>/);
    }
  } finally { chart.dispose(); }
});

test("the application's fixed pie tooltip template escapes label substitutions", () => {
  for (const name of labels) {
    const html = htmlSink(formatTpl("{b}: {c} ({d}%)", { $vars: ["seriesName", "name", "value", "percent"], seriesName: "对照", name, value: 7, percent: 100 }, true));
    assert.equal(html, `${encodeHTML(name)}: 7 (100%)`);
  }
});
