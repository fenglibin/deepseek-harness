# archived-sessions 规范增量

## ADDED Requirements

### Requirement: 归档集合安装有请求序号守卫

客户端工作区模型的归档集合安装 SHALL 受单调递增的请求序号守卫。一元归档或取消归档操作 SHALL 只在其序号仍为最新时安装回复中的集合。基线替换与 stream 增量 SHALL 自增该序号，使在途的一元回复作废。

#### Scenario: 陈旧回复不覆盖新集合

- **WHEN** 一次取消归档请求的回复晚于一次更新的归档请求到达
- **THEN** 较晚到达的陈旧回复 SHALL NOT 安装其集合
- **AND** 归档集合 SHALL 保持为较新请求的结果

#### Scenario: 推送增量作废在途回复

- **WHEN** 一个归档集合的 stream 增量在某个一元请求的回复之前到达
- **THEN** 该一元请求的回复到达时 SHALL NOT 安装其集合
- **AND** 集合 SHALL 保持为增量推送的值

#### Scenario: 最新回复正常安装

- **WHEN** 一次归档或取消归档请求的回复到达且没有更新的请求或推送
- **THEN** 该回复的集合 SHALL 被安装

### Requirement: 设置页提供已归档会话恢复入口

设置页 SHALL 提供已归档会话分节，按归档时间由新到旧列出可恢复的会话，每行 SHALL 提供取消归档操作。

该分节 SHALL 读取工作区模型的归档集合与会话列表，SHALL NOT 持有自己的 store。

#### Scenario: 列出已归档会话

- **WHEN** 用户打开设置页的已归档会话分节
- **THEN** 该分节 SHALL 按归档时间由新到旧列出行
- **AND** 每行 SHALL 显示会话标题与所属工作区及最近活动时间

#### Scenario: 取消归档后会话离开列表

- **WHEN** 用户点击某一行的取消归档操作
- **THEN** 客户端 SHALL 调用工作区模型的取消归档
- **AND** 该会话 SHALL 从已归档列表移除
- **AND** 它 SHALL 重新出现在工作区导航中

#### Scenario: 无摘要的归档成员不产生行

- **WHEN** 归档集合含一个没有已加载会话摘要的成员
- **THEN** 该成员 SHALL NOT 产生行
- **AND** SHALL NOT 产生无法完成的取消归档操作

#### Scenario: 搜索按标题或工作区过滤

- **WHEN** 用户在分节的搜索框输入文本
- **THEN** 列表 SHALL 只保留标题或工作区名包含该文本的行

### Requirement: 已归档会话分节区分三种空态

分节 SHALL 区分"归档集合为空"、"归档成员均无已加载会话"与"查询无匹配"三种状态，并 SHALL 为每种状态显示不同文案。

#### Scenario: 归档集合为空

- **WHEN** 归档集合为空
- **THEN** 分节 SHALL 显示空归档文案

#### Scenario: 归档成员均无可恢复会话

- **WHEN** 归档集合非空但其成员都没有已加载摘要
- **THEN** 分节 SHALL 显示"无可恢复会话"文案
- **AND** SHALL NOT 显示空归档文案

#### Scenario: 查询无匹配

- **WHEN** 搜索查询非空且没有行匹配
- **THEN** 分节 SHALL 显示无匹配文案
