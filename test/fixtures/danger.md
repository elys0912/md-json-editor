# 危険な HTML

<script>alert(1)</script>

<img src="x" onerror="alert(1)">

<a href="javascript:alert(1)">raw</a>

[md](javascript:alert(1))

<style>body { display: none; }</style>

<form action="https://example.com/"><input type="text" name="q"><label>名前</label><button>送る</button></form>

<p style="color: red">色付き</p>

<div id="app">利用者の id</div>

<p data-line="00000000-0000-0000-0000-000000000000:1">偽の印</p>

- [ ] タスク

[外部](https://example.com/) [内部](#危険な-html)
