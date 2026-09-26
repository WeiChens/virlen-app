/**
 * price-editor — 模型单价编辑
 *
 * 费用估算必须有单价，而单价「服务商随时会调、各家口径也不同」，
 * 所以这里让用户按 (Provider, 模型) 逐个填；未填的模型回退到内置价目表。
 *
 * 内置价目表是预估值，UI 必须提示用户核对（见 DEFAULT_MODEL_PRICES 注释）。
 */
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { findDefaultPriceEntryInCurrency, priceKey, type ModelPrice } from '@/domain/pricing'
import { t } from '@/ui/i18n'
import Select from '@/ui/components/shared/Select'
import { showToast } from '@/ui/components/shared/Toast'

/** 未配置、且内置价目表也没收录时的占位单价 */
const ZERO_PRICE: ModelPrice = { input: 0, output: 0, cachedInput: 0 }

/** 币种选项（默认人民币；内置 USD 预估价会按 USD_TO_CNY 折算；用户自填价按其币种原样使用） */
const CURRENCIES = [
  { value: 'CNY', label: 'CNY (¥)' },
  { value: 'USD', label: 'USD ($)' },
]

const PriceEditor = observer(function PriceEditor() {
  const providers = settingsState.value.providers
  const pricing = settingsState.value.modelPricing || {}
  const currency = settingsState.value.usageCurrency

  /**
   * 写入一行单价。
   *
   * `base` 必须传「当前生效的单价」而不是全 0：用户只改输出价时，输入价要保持生效值
   * （可能是内置预估价），否则会被悄悄归零、费用算少。
   */
  const setPrice = (
    key: string,
    base: ModelPrice,
    patch: Partial<ModelPrice>,
  ) => {
    settingsState.setValue('modelPricing', {
      ...pricing,
      [key]: { ...base, ...patch },
    })
  }

  const resetPrice = (key: string) => {
    const next = { ...pricing }
    delete next[key]
    settingsState.setValue('modelPricing', next)
  }

  const rows = providers.flatMap((p) =>
    p.models.map((model) => ({
      providerId: p.id,
      providerName: p.name,
      model,
      key: priceKey(p.id, model),
      /** 内置预估价条目（未收录 → null）；价已折算到当前币种，label 原样 */
      builtin: findDefaultPriceEntryInCurrency(model, currency),
    })),
  )

  return (
    <div className="token-stats-pricing">
      <p className="pricing-hint">
        {t(
          '费用按你填写的单价估算，非账单。未填写的模型会使用内置预估价，请以服务商官方价格为准。',
        )}
      </p>
      <p className="pricing-hint">
        {t(
          '表格里显示的就是当前生效的单价：内置预估价可直接编辑，改动任一栏即保存为自定义价，点「恢复内置价」可还原；标着「未收录」的模型必须手动填写，否则费用按 0 计。',
        )}
      </p>
      <p className="pricing-hint">
        {t(
          '内置预估价以美元存储，切换币种时按固定汇率（1 USD = 7.2 CNY）折算；你手填的单价按当前币种原样使用。',
        )}
      </p>

      <div className="pricing-currency">
        <span>{t('币种')}</span>
        <Select
          value={currency}
          options={CURRENCIES}
          width={120}
          onChange={(v) =>
            settingsState.setValue('usageCurrency', v as 'USD' | 'CNY')
          }
        />
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            settingsState.setValue('modelPricing', {})
            showToast(t('已恢复内置预估价'), 2000)
          }}>
          {t('全部恢复内置价')}
        </button>
      </div>

      {rows.length === 0 && <p className="pricing-empty">{t('还没有配置任何模型服务商')}</p>}

      {rows.length > 0 && (
        <table className="pricing-table">
          <thead>
            <tr>
              <th>{t('模型')}</th>
              <th>{t('输入价')}</th>
              <th>{t('输出价')}</th>
              <th>{t('缓存价')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const custom = pricing[row.key]
              // 生效单价 = 自定义 > 内置预估 > 0。
              // 输入框必须回显**生效值**：否则点「全部恢复内置价」后整表都是 0，
              // 看起来像单价丢了（实际费仍按内置价算，只有未收录的模型才是真 0）。
              const effective: ModelPrice =
                custom ?? row.builtin?.price ?? ZERO_PRICE
              return (
                <tr key={row.key}>
                  <td>
                    <div className="model-name" title={row.model}>
                      {row.model}
                    </div>
                    <div className="model-meta">
                      {row.providerName}
                      {custom
                        ? ` · ${t('自定义')}`
                        : row.builtin
                          ? ` · ${t('内置预估')}（${row.builtin.label}）`
                          : ` · ${t('未收录，按 0 计')}`}
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={effective.input}
                      onChange={(e) =>
                        setPrice(row.key, effective, {
                          input: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={effective.output}
                      onChange={(e) =>
                        setPrice(row.key, effective, {
                          output: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={effective.cachedInput ?? 0}
                      onChange={(e) =>
                        setPrice(row.key, effective, {
                          cachedInput: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    {custom && (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => resetPrice(row.key)}>
                        {t('恢复内置价')}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="pricing-unit">{t('单位：每 1,000,000 tokens')}</p>
    </div>
  )
})

export default PriceEditor
