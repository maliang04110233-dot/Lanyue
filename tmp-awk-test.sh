set -euo pipefail
V="1.0.36"
NOTES=$(awk -v v="$V" '
  $0 ~ "^## \["v"\]" {flag=1; next}
  flag; /^## \[/ {exit}
  flag {print}
' CHANGELOG.md | sed '/./,$!d')
{
  echo "## ${V}"
  echo
  echo "${NOTES:-（CHANGELOG 中该版本条目为空）}"
  echo
  echo "---"
  echo "footer"
} > notes.md
echo "EXIT=$?"
wc -l notes.md