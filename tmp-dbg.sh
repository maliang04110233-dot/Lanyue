echo "--- 第 11/13/86 行 ---"
awk 'NR==11; NR==13; NR==86 {printf("NR=%d len=%d [%.20s]\n", NR, length($0), $0)}' CHANGELOG.md
echo "--- index 测试 ---"
awk 'NR==13 {print "index结果:", index($0, "## [1.0.36]"); print "等于1?", (index($0,"## [1.0.36]")==1)}' CHANGELOG.md
echo "--- 文件行尾 ---"
head -14 CHANGELOG.md | tail -3 | od -c | tail -3