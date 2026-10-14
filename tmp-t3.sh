echo "=== 纯 awk 抽取（无 set -e）==="
NOTES=$(awk -v v="1.0.36" '
  index($0, "## [" v "]") == 1 {flag=1; next}
  flag; index($0, "## [") == 1 {exit}
  flag {print}
' CHANGELOG.md)
echo "退出码=$? 长度=${#NOTES}"
printf '%s\n' "$NOTES" | head -6
echo "=== 加 set -euo pipefail 后 ==="
( set -euo pipefail
  N2=$(awk -v v="1.0.36" 'index($0, "## [" v "]") == 1 {flag=1; next} flag; index($0, "## [") == 1 {exit} flag {print}' CHANGELOG.md)
  echo "长度=${#N2}" )
echo "子shell 退出码=$?"