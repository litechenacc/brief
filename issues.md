~~1. receiving token 在被真的換成tool call前同樣沒有ui 顯示，因此感覺仍然像卡住; thought process 在建立的過程中，沒有展開時，看不到token 被傳回因此感覺仍然像卡住; 

我想實際上應該很明確review 一下所有對話中可能async 的地方，全部都使用 loading 機制來替代掉 ui looks like freezed 的現象;

首先review 然後討論一下他們的ui顯示上的分類，然後協助我思考怎麼設計loading ~~


1. 新增一區顯示所有的 working sessions (toggled foldable)
~~1. 有一些thinking trace 好像斷掉了(01a08fb6)，查看一下是ui bug 還是真的有斷~~

輸入