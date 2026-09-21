/**
 * usage-chart — 用量统计图表（echarts 按需引入）
 *
 * 只注册用到的图表与组件（BarChart / LineChart / PieChart / Grid / Tooltip / Legend），
 * 避免整包 echarts 进打包体积。
 *
 * 颜色与文字颜色从主题 CSS 变量读取，跟随亮/暗色主题。
 */
import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { formatCost, formatTokens } from '@/domain/pricing'
import { t } from '@/ui/i18n'
import type { CostedBucket } from '@/services/token-stats-service'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
])

/** 从主题读取一个 CSS 变量（图表不能直接用 var()，必须取实际色值） */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return v || fallback
}

/** tooltip 走 HTML：模型 id / 会话标题是外部字符串，必须转义后再拼（防注入） */
function escapeHtml(s: string): string {
  return (s ?? '').replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
  )
}

interface ThemeColors {
  text: string
  sub: string
  border: string
  input: string
  output: string
  cached: string
}

function themeColors(): ThemeColors {
  return {
    text: cssVar('--text-primary', '#1a1a1a'),
    sub: cssVar('--text-secondary', '#666'),
    border: cssVar('--border-color', '#e5e5e5'),
    input: cssVar('--primary', '#4f46e5'),
    output: cssVar('--accent-warn', '#f59e0b'),
    cached: cssVar('--accent-success', '#22c55e'),
  }
}

/** 轴类图表（柱 / 折线）共用的 tooltip：悬停某列 / 某点显示该桶的完整拆解 */
function tokenAxisTooltip(
  buckets: CostedBucket[],
  labelOf: (key: string) => string,
  currency: string,
  c: ThemeColors,
  pointer: 'shadow' | 'line',
): any {
  return {
    trigger: 'axis',
    axisPointer: { type: pointer },
    backgroundColor: cssVar('--bg-primary', '#fff'),
    borderColor: c.border,
    textStyle: { color: c.text, fontSize: 12 },
    formatter: (params: any) => {
      const idx = Array.isArray(params) ? params[0]?.dataIndex ?? 0 : 0
      const b = buckets[idx]
      if (!b) return ''
      return [
        `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(labelOf(b.key))}</div>`,
        `${t('调用次数')}: ${b.calls}`,
        `${t('输入')}: ${formatTokens(b.promptTokens)}`,
        `${t('输出')}: ${formatTokens(b.completionTokens)}`,
        `${t('缓存')}: ${formatTokens(b.cachedTokens)}`,
        `${t('合计')}: <b>${formatTokens(b.totalTokens)}</b>`,
        `${t('费用')}: ${formatCost(b.cost.total, currency)}`,
      ].join('<br/>')
    },
  }
}

/** 用量分布：堆叠柱（输入 / 输出 / 缓存），tooltip 附带费用 */
export function buildTokenBarOption(
  buckets: CostedBucket[],
  labelOf: (key: string) => string,
  currency: string,
): EChartsCoreOption {
  const c = themeColors()
  const labels = buckets.map((b) => labelOf(b.key))
  return {
    textStyle: { color: c.text },
    grid: { left: 8, right: 12, top: 34, bottom: 4, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: c.sub, fontSize: 11 },
    },
    tooltip: tokenAxisTooltip(buckets, labelOf, currency, c, 'shadow'),
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: c.border } },
      axisTick: { show: false },
      axisLabel: { color: c.sub, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: c.border, type: 'dashed' } },
      axisLabel: {
        color: c.sub,
        fontSize: 11,
        formatter: (v: number) => formatTokens(v),
      },
    },
    series: [
      {
        name: t('输入'),
        type: 'bar',
        stack: 'tokens',
        itemStyle: { color: c.input },
        barMaxWidth: 26,
        data: buckets.map((b) => b.promptTokens),
      },
      {
        name: t('输出'),
        type: 'bar',
        stack: 'tokens',
        itemStyle: { color: c.output },
        barMaxWidth: 26,
        data: buckets.map((b) => b.completionTokens),
      },
      {
        name: t('缓存'),
        type: 'bar',
        stack: 'tokens',
        itemStyle: { color: c.cached },
        barMaxWidth: 26,
        data: buckets.map((b) => b.cachedTokens),
      },
    ],
  }
}

/**
 * 用量趋势：平滑折线（输入 / 输出 / 缓存三条），用于小时 / 天 / 周 / 月等时间维度。
 *
 * 时间维度的本质是「趋势」，折线比堆叠柱直观。三条线**各自独立不堆叠** —— 堆叠的
 * 折线会被误读成累计量。配色与 tooltip 与柱状图完全一致，切换维度时不跳色。
 */
export function buildTokenLineOption(
  buckets: CostedBucket[],
  labelOf: (key: string) => string,
  currency: string,
): EChartsCoreOption {
  const c = themeColors()
  const labels = buckets.map((b) => labelOf(b.key))
  const line = (name: string, color: string, data: number[]) => ({
    name,
    type: 'line' as const,
    smooth: true,
    symbol: 'circle' as const,
    symbolSize: 6,
    // 点太密时不画标记，否则糊成一片
    showSymbol: buckets.length <= 40,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    // 淡面积：突出趋势，透明度很低，三条叠加也不糊
    areaStyle: { color, opacity: 0.08 },
    emphasis: { focus: 'series' as const },
    data,
  })
  return {
    textStyle: { color: c.text },
    grid: { left: 8, right: 12, top: 34, bottom: 4, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: c.sub, fontSize: 11 },
    },
    tooltip: tokenAxisTooltip(buckets, labelOf, currency, c, 'line'),
    xAxis: {
      type: 'category',
      // 折线两端贴边，不留柱状图那种半格空隙
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: c.border } },
      axisTick: { show: false },
      axisLabel: { color: c.sub, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: c.border, type: 'dashed' } },
      axisLabel: {
        color: c.sub,
        fontSize: 11,
        formatter: (v: number) => formatTokens(v),
      },
    },
    series: [
      line(t('输入'), c.input, buckets.map((b) => b.promptTokens)),
      line(t('输出'), c.output, buckets.map((b) => b.completionTokens)),
      line(t('缓存'), c.cached, buckets.map((b) => b.cachedTokens)),
    ],
  }
}

/** 一个饼图扇区；`lines` 是 tooltip 的明细行（HTML 片段，调用方已转义） */
export interface PieSlice {
  name: string
  value: number
  lines: string[]
}

/**
 * 占比饼图（调用类型 / 模型用量 / token 类型 / 费用四种维度共用）。
 *
 * 数值口径由调用方决定（token 总量 / 单模型费用 / 各类型 token），
 * 这里只负责把 `slices` 画成扇区并渲染 tooltip。
 */
export function buildPieOption(slices: PieSlice[]): EChartsCoreOption {
  const c = themeColors()
  const palette = [c.input, c.output, c.cached, '#8b5cf6', '#06b6d4', '#ef4444']
  return {
    textStyle: { color: c.text },
    tooltip: {
      trigger: 'item',
      backgroundColor: cssVar('--bg-primary', '#fff'),
      borderColor: c.border,
      textStyle: { color: c.text, fontSize: 12 },
      formatter: (p: any) => {
        const s = slices[p.dataIndex]
        if (!s) return ''
        return [
          `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(s.name)}</div>`,
          ...s.lines,
        ].join('<br/>')
      },
    },
    legend: {
      bottom: 0,
      icon: 'circle',
      textStyle: { color: c.sub, fontSize: 11 },
    },
    color: palette,
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: cssVar('--bg-primary', '#fff'), borderWidth: 2 },
        label: { show: false },
        data: slices.map((s) => ({ name: s.name, value: s.value })),
      },
    ],
  }
}

/** 通用 echarts 容器（自适应尺寸 + 卸载释放） */
export function UsageChart({
  option,
  height = 260,
}: {
  option: EChartsCoreOption
  height?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = echarts.init(host)
    chartRef.current = chart
    // 面板宽度会随窗口缩放变化，不用 ResizeObserver 图表会留白
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => chart.resize())
        : null
    ro?.observe(host)
    return () => {
      ro?.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // 主题切换 / 数据变化时整份替换配置（第二个参数 notMerge=true，避免残留旧系列）
  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  const style = useMemo(() => ({ height }), [height])
  return <div className="token-stats-chart" ref={hostRef} style={style} />
}
