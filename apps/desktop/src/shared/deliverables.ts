/** 交付卡（present_files）上一个文件的信息：主进程 deliverables:inspect 返回，渲染层据此绘制。 */
export interface DeliverableInfo {
  path: string
  name: string
  dir: string
  /** 字节数；null = 文件已不存在（被移走或删除）。 */
  size: number | null
  /** 是否允许用默认应用打开（可执行 / 脚本类不允许，只能在文件夹中显示）。 */
  openable: boolean
}
