/** Structured todo-list rendering from validated plain card data. @module */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TodoCard.module.css'

/** One todo item as the row presents it: content plus a three-way status. */
export interface TodoCardItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Localized status-label key per todo status. */
const STATUS_KEYS = {
  pending: 'todo.status.pending',
  in_progress: 'todo.status.in_progress',
  completed: 'todo.status.completed',
} as const

/**
 * Render a structured todo list from plain card data: one row per item with a
 * status marker, the task text, and a localized status label.
 * @param props - the todo items and the row's locale seat.
 * @returns the readable todo list.
 */
export function TodoCard({ todos, t }: { todos: readonly TodoCardItem[]; t: TranslateNS<'conversation'> }) {
  return (
    <ul className={css.list}>
      {todos.map((todo, index) => (
        <li key={`${todo.content}-${String(index)}`} className={css.item} data-status={todo.status}>
          <span className={css.marker} data-status={todo.status} aria-hidden />
          <span className={css.content}>{todo.content}</span>
          <span className={css.status}>{t(STATUS_KEYS[todo.status])}</span>
        </li>
      ))}
    </ul>
  )
}
