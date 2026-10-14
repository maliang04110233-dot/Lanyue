set -euo pipefail
V="1.0.36"
# 用 index() 而不是正则：原写法 "^## \["v"\]" 里的 \[ 在 awk 里转义不可靠
# （本地实测 gawk 5.4 报 warning 并把 \[ 当普通 [，于是 [1.0.36] 变成字符类，
#   flag 从不置 1，NOTES 永远为空）；第二段 /^## \[/ 同理。
# index() 做纯字面量比较，没有转义、没有字符类，任何 awk 实现（mawk/gawk/BSD）一致。
NOTES=$(awk -v v="$V" '
  index($0, "## [" v "]") == 1 {flag=1; next}
  flag; index($0, "## [") == 1 {exit}
  flag {print}
' CHANGELOG.md)
if [ -z "${NOTES//[[:space:]]/}" ]; then
  echo "::error::CHANGELOG.md 里找不到 ## [$V] 条目" >&2
  exit 1
fi
{
  echo "## ${V}"
  echo
  echo "${NOTES}"
  echo
  echo "---"
  echo "由 Release workflow 自动生成。安装包**未做代码签名**，Windows 可能显示 SmartScreen 提示。"
} > notes.md
echo "EXIT=$?  行数=$(wc -l < notes.md)"