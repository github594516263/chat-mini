/**
 * 这个文件返回 null，但它存在本身有意义。
 *
 * 有 loading 边界，Next 才愿意在客户端导航时"先提交 URL、再等 RSC"，
 * 也才愿意预取这一段；没有它，动态段只能整段等回来，地址栏就慢半拍。
 * 因为页面本身也是 null，这里的 fallback 什么都不用画 —— 纯协议层的东西。
 */
export default function Loading() {
  return null;
}
