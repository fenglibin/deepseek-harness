/**
 * `fileBrowser` namespace dictionaries: the manager dialog's chrome, the tree
 * row verbs, the editor's save/conflict affordances, and every degrade notice.
 * Runtime failure messages (wire error strings) pass through untranslated by
 * policy.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'menu.open': '工作区文件',
  'dialog.title': '工作区文件',
  'dialog.close': '关闭',

  'tree.aria': '文件树',
  'tree.loading': '加载中…',
  'tree.empty': '此目录为空',
  'tree.truncated': '条目过多，仅显示开头部分。',
  'tree.showHidden': '显示隐藏项',
  'tree.retry': '重试',
  'tree.failed': '无法加载该目录。',
  'tree.actions.aria': '“{name}”的操作',

  'file.newFile': '新建文件',
  'file.newFolder': '新建文件夹',
  'file.rename': '重命名',
  'file.delete': '删除',
  'file.name': '名称',
  'file.createIn': '在“{name}”中新建',
  'file.untitled': '未命名',
  'file.create': '创建',
  'file.cancel': '取消',
  'file.confirm': '确定',

  'delete.title': '删除',
  'delete.description': '将永久删除“{name}”，此操作不可恢复。',
  'delete.acknowledge': '我了解此操作不可恢复',
  'delete.confirm': '删除',
  'delete.close': '关闭',

  'content.none': '从左侧选择一个文件',
  'content.binary': '这不是文本文件，无法在此查看或编辑。',
  'content.tooLarge': '文件过大（{size}），超过 {limit} 的上限。',
  'content.failed': '无法读取该文件。',
  'content.readonly': '只读',
  'content.save': '保存',
  'content.saving': '保存中…',
  'content.saved': '已保存',
  'content.unsaved': '未保存',
  'content.reload': '重新加载',
  'content.saveFailed': '保存失败。',
  'content.conflict': '该文件已在磁盘上被其它程序改动，未覆盖。',
  'content.overwrite': '强制覆盖',
  'content.image.aria': '图片预览：{name}',
  'size.bytes': '{n} B',
  'size.kilobytes': '{n} KB',
  'size.megabytes': '{n} MB',

  'search.placeholder': '按文件名搜索…',
  'search.aria': '搜索文件',
  'search.clear': '清除搜索',
  'search.empty': '无匹配文件',
  'search.truncated': '仅显示前 {n} 条结果，请缩小搜索范围。',
  'search.failed': '搜索失败。',
  'search.results.aria': '搜索结果',
}

/** Every key this namespace carries. */
export type FileBrowserKey = keyof typeof zh
