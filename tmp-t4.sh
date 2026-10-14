echo "=== 谁匹配了 '## [1.0.36]' ==="
awk -v v="1.0.36" 'index($0, "## [" v "]")==1 {print "MATCH NR=" NR " [" $0 "]"}' CHANGELOG.md
echo "=== 谁匹配了 '## ['（行首）==="
awk 'index($0, "## [")==1 {print "NR=" NR " [" $0 "]"}' CHANGELOG.md
echo "=== -v 传参是否被当成数字 ==="
awk -v v="1.0.36" 'BEGIN{print "v=[" v "] len=" length(v)}'