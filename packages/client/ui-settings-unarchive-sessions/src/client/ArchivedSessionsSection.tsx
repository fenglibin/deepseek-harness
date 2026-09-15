/**
 * 已归档会话设置页：把注册表全局归档集合与已加载的 Session 摘要合并，最近归档的
 * 排在前面，用一个搜索框过滤，每行提供一个取消归档操作。会话记录已不存在的归档
 * 条目既没有行也没有操作；集合本身始终归 Host 所有。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './ArchivedSessionsSection.module.css'

/** 页面使用的注册期注入面。 */
export interface ArchivedSessionsSectionInjected {
  /**
   * 恢复一个已归档的 Session。
   * @param sessionId - 要取消归档的 Session。
   */
  unarchive: (sessionId: SessionId) => Promise<void>
}

/** 设置 slot 渲染器组装出的完整组件 props。 */
export type ArchivedSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.archivedSessions'>
  & InjectFace<ArchivedSessionsSectionInjected>

type Translate = ArchivedSessionsSectionProps['t']

/** 页面渲染出的一个已归档 Session 行。 */
interface ArchivedRow {
  id: SessionId
  title: string
  /** 所属 Workspace 标题；不属于任何 Workspace 时是未分组标签。 */
  workspace: string
  updatedAt: number
}

/**
 * 一行最近活动的本地化紧凑相对时间。
 * @param updatedAt - 该行最近活动的 epoch 毫秒。
 * @param now - 当前 epoch 毫秒（注入以保证渲染是纯函数）。
 * @param t - 本分节的翻译函数。
 * @returns 该行尾部的相对时间文案。
 */
function timeLabel(updatedAt: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/**
 * 一行是否匹配已规范化的查询串（标题或 Workspace 标签）。
 * @param row - 待判定的行。
 * @param normalizedQuery - 已去空白并转小写的查询串。
 * @returns 匹配或查询为空时为 true。
 */
function matches(row: ArchivedRow, normalizedQuery: string): boolean {
  return normalizedQuery.length === 0
    || row.title.toLowerCase().includes(normalizedQuery)
    || row.workspace.toLowerCase().includes(normalizedQuery)
}

/**
 * 渲染已归档会话页。
 * @param props - 组装好的 slot props（见 {@link ArchivedSessionsSectionProps}）。
 * @returns 设置页元素树。
 */
export function ArchivedSessionsSection(props: ArchivedSessionsSectionProps): ReactNode {
  const { t, unarchive, useSessions, useWorkspaces } = props
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state.items)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const [query, setQuery] = useState('')
  const ungrouped = t('ungrouped')
  const summaries = sessions.byId

  // 归档顺序由旧到新；页面把最近归档的 Session 排在前面。没有已加载摘要的成员
  // 在这里无法寻址，因此不产生行。
  const rows = useMemo<ArchivedRow[]>(() => {
    const owners = new Map<string, string>()
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) owners.set(id, workspace.title)
    }
    return [...archivedSessionIds].reverse().flatMap((id) => {
      const summary = summaries[id]
      if (summary === undefined) return []
      return [{
        id,
        title: summary.displayTitle,
        workspace: owners.get(id) ?? ungrouped,
        updatedAt: summary.updatedAt,
      }]
    })
  }, [archivedSessionIds, workspaces, summaries, ungrouped])

  if (sessions.phase !== 'ready') return <p className={css.status}>{t('loading')}</p>

  const now = Date.now()
  const visible = rows.filter(row => matches(row, query.trim().toLowerCase()))
  const archived = archivedSessionIds.length > 0

  return (
    <div className={css.section}>
      <div className={css.search}>
        <IconSearchOutline16 aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('search')}
          aria-label={t('search')}
          onChange={(event) => { setQuery(event.currentTarget.value) }}
        />
      </div>
      {!archived ? <p className={css.status}>{t('empty')}</p> : null}
      {archived && rows.length === 0 ? <p className={css.status}>{t('unavailable')}</p> : null}
      {rows.length > 0 && visible.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {visible.length > 0 ? (
        <ul className={css.list}>
          {visible.map(row => (
            <li key={row.id} className={css.row}>
              <span className={css.identity}>
                <span className={css.title}>{row.title}</span>
                <span className={css.meta}>
                  {[row.workspace, timeLabel(row.updatedAt, now, t)].join(' · ')}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                aria-label={t('unarchiveNamed', { title: row.title })}
                onClick={() => {
                  unarchive(row.id).catch((reason: unknown) => {
                    console.warn('session unarchive rejected:', reason)
                  })
                }}
              >
                {t('unarchive')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
