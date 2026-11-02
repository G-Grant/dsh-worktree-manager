/**
 * The bundle configuration view on the Plugins page. The page owns the title,
 * icon and breadcrumb; this component answers the slot's owner props —
 * `view: 'summary'` renders one descriptive line on the bundle's row,
 * `view: 'page'` renders the configuration form and the worktree manager list.
 * Renders nothing while the namespace is unavailable.
 */

import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardActions, CardStore } from './card-form.ts'
import { ManagerList, type ManagerFace } from './ManagerList.tsx'
import css from './ConfigCard.module.css'

/** Props the renderer binds for the bundle configuration. */
export type ConfigCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'worktree-manager'>
  & InjectFace<ConfigCardFace>
  & PluginConfigViewProps

/** The registration-side face this slot entry injects. */
export interface ConfigCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWorktreeManagerCard. */
    worktreeManagerCard: CardStore
  }
  manager: ManagerFace
}

/** Render the configuration. */
export function ConfigCard(props: ConfigCardProps) {
  const { t } = props
  const state = props.useWorktreeManagerCard(snapshot => snapshot)
  if (!state.available) return null
  if (props.view !== 'page') return <p className={css.summary}>{t('card.description')}</p>

  const lock = !state.writable
  const canSave = state.dirty && !state.saving && state.copyFilesValid && !lock
  const switchBad = (field: typeof state.switchFailed): boolean => state.switchFailed === field

  return (
    <div className={css.page}>
      {lock && <p className={css.note} role="status">{t('card.readOnly')}</p>}

      <fieldset className={`${css.field} ${css.radioGroup}`} disabled={lock}>
        <legend className={css.label}>{t('card.naming')}</legend>
        <label className={css.radio}>
          <input
            type="radio"
            name="wtm-naming"
            value="manual"
            checked={state.namingMode === 'manual'}
            onChange={() => { void props.setNamingMode('manual') }}
          />
          {t('card.namingManual')}
        </label>
        <label className={css.radio}>
          <input
            type="radio"
            name="wtm-naming"
            value="auto"
            checked={state.namingMode === 'auto'}
            onChange={() => { void props.setNamingMode('auto') }}
          />
          {t('card.namingAuto')}
        </label>
        <p className={css.hint}>{t('card.namingHint')}</p>
        {switchBad('namingMode') && <p className={css.bad} role="alert">{t('card.switchFailed')}</p>}
      </fieldset>

      <div className={`${css.field} ${css.toggleRow}`}>
        <span className={css.toggleText}>
          <span className={css.toggleLabel}>{t('card.autoCleanup')}</span>
          <span className={css.hint}>{t('card.autoCleanupHint')}</span>
          {switchBad('autoCleanup') && <span className={css.bad} role="alert">{t('card.switchFailed')}</span>}
        </span>
        <Switch
          checked={state.autoCleanup}
          disabled={lock}
          label={t('card.autoCleanup')}
          onChange={(next) => { void props.setAutoCleanup(next) }}
        />
      </div>

      <div className={`${css.field} ${css.toggleRow}`}>
        <span className={css.toggleText}>
          <span className={css.toggleLabel}>{t('card.deleteBranch')}</span>
          <span className={css.hint}>{t('card.deleteBranchHint')}</span>
          {switchBad('deleteBranchOnCleanup') && <span className={css.bad} role="alert">{t('card.switchFailed')}</span>}
        </span>
        <Switch
          checked={state.deleteBranchOnCleanup}
          disabled={lock}
          label={t('card.deleteBranch')}
          onChange={(next) => { void props.setDeleteBranchOnCleanup(next) }}
        />
      </div>

      <div className={`${css.field} ${css.toggleRow}`}>
        <span className={css.toggleText}>
          <span className={css.toggleLabel}>{t('card.fetchBase')}</span>
          <span className={css.hint}>{t('card.fetchBaseHint')}</span>
          {switchBad('fetchBaseBeforeCreate') && <span className={css.bad} role="alert">{t('card.switchFailed')}</span>}
        </span>
        <Switch
          checked={state.fetchBaseBeforeCreate}
          disabled={lock}
          label={t('card.fetchBase')}
          onChange={(next) => { void props.setFetchBaseBeforeCreate(next) }}
        />
      </div>

      <div className={css.field}>
        <span className={css.label}>{t('card.copyFiles')}</span>
        <textarea
          className={`${css.textarea} ${state.copyFilesValid ? '' : css.inputBad}`}
          value={state.copyFilesText}
          disabled={lock}
          placeholder={'.env\n.env.local'}
          onChange={(event) => { props.editCopyFiles(event.target.value) }}
        />
        <p className={state.copyFilesValid ? css.hint : css.bad}>
          {state.copyFilesValid ? t('card.copyFilesHint') : t('card.copyFilesInvalid')}
        </p>
      </div>

      <div className={css.actions}>
        {state.failed && <span className={css.bad} role="alert">{t('card.saveFailed')}</span>}
        <Button variant="ghost" size="sm" disabled={!state.dirty || state.saving} onClick={props.discard}>{t('card.discard')}</Button>
        <Button variant="primary" size="sm" disabled={!canSave} onClick={() => { void props.save() }}>
          {state.saving ? t('card.saving') : t('card.save')}
        </Button>
      </div>

      <ManagerList face={props.manager} t={t} />
    </div>
  )
}
