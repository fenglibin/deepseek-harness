/**
 * Dictionary namespace owned by the prompt-command settings section.
 */

/** Locale keys this section renders. */
export type PromptCommandKey =
  | 'nav' | 'title' | 'empty' | 'emptyHint'
  | 'add' | 'edit' | 'delete'
  | 'deleteTitle' | 'deleteDescription' | 'deleteAcknowledge' | 'deleteCancel' | 'deleteConfirm'
  | 'save' | 'cancel'
  | 'fieldName' | 'fieldTitle' | 'fieldDescription' | 'fieldPrompt' | 'fieldHint'
  | 'titleOptional' | 'hintOptional'
  | 'readOnly'
  | 'invalid'

/** Simplified Chinese copy. */
export const zh: Record<PromptCommandKey, string> = {
  nav: '提示词命令',
  title: '提示词命令',
  empty: '暂无提示词命令',
  emptyHint: '添加常用提示词快捷方式，输入 / 即可调用。',
  add: '添加命令',
  edit: '编辑命令',
  delete: '删除',
  deleteTitle: '删除命令',
  deleteDescription: '删除后该 /命令 将不再可用，此操作不可撤销。',
  deleteAcknowledge: '我确认要删除这条命令',
  deleteCancel: '取消',
  deleteConfirm: '删除',
  save: '保存',
  cancel: '取消',
  fieldName: '命令名',
  fieldTitle: '显示名称',
  fieldDescription: '描述',
  fieldPrompt: '提示词内容',
  fieldHint: '输入提示',
  titleOptional: '可选',
  hintOptional: '可选',
  readOnly: '当前部署的设置为只读，无法修改命令。',
  invalid: '命令名需为小写字母、数字、连字符或下划线；命令名、描述和提示词内容不能为空',
}

/** English copy. */
export const en: Record<PromptCommandKey, string> = {
  nav: 'Prompt Commands',
  title: 'Prompt Commands',
  empty: 'No prompt commands',
  emptyHint: 'Add reusable prompt shortcuts; type / to invoke them.',
  add: 'Add command',
  edit: 'Edit command',
  delete: 'Delete',
  deleteTitle: 'Delete command',
  deleteDescription: 'This /command will no longer be available after deletion. This cannot be undone.',
  deleteAcknowledge: 'I confirm I want to delete this command',
  deleteCancel: 'Cancel',
  deleteConfirm: 'Delete',
  save: 'Save',
  cancel: 'Cancel',
  fieldName: 'Command name',
  fieldTitle: 'Display name',
  fieldDescription: 'Description',
  fieldPrompt: 'Prompt text',
  fieldHint: 'Input hint',
  titleOptional: 'Optional',
  hintOptional: 'Optional',
  readOnly: 'This deployment stores settings read-only.',
  invalid: 'Command name must be lowercase letters, digits, hyphens, or underscores; name, description, and prompt text are required',
}
