## Default Permission

Paper's own window may build and query the passage index.

Every command here is local: the index is built from books already on this
device and nothing is sent anywhere. The commands that WRITE are reachable only
from Paper's own window — a web session reaches the index through the service
table's `passage.search` row, which is a different door with its own audience
and its own grant.

#### This default permission set includes the following:

- `allow-passages-put`
- `allow-passages-note`
- `allow-passages-flush`
- `allow-passages-forget`
- `allow-passages-rekey`
- `allow-passages-pending`
- `allow-passages-indexed`
- `allow-passages-rebuild`
- `allow-passages-retry`
- `allow-passages-status`
- `allow-passages-search`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`passages:allow-passages-flush`

</td>
<td>

Enables the passages_flush command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-flush`

</td>
<td>

Denies the passages_flush command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-forget`

</td>
<td>

Enables the passages_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-forget`

</td>
<td>

Denies the passages_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-indexed`

</td>
<td>

Enables the passages_indexed command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-indexed`

</td>
<td>

Denies the passages_indexed command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-note`

</td>
<td>

Enables the passages_note command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-note`

</td>
<td>

Denies the passages_note command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-pending`

</td>
<td>

Enables the passages_pending command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-pending`

</td>
<td>

Denies the passages_pending command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-put`

</td>
<td>

Enables the passages_put command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-put`

</td>
<td>

Denies the passages_put command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-rebuild`

</td>
<td>

Enables the passages_rebuild command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-rebuild`

</td>
<td>

Denies the passages_rebuild command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-rekey`

</td>
<td>

Enables the passages_rekey command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-rekey`

</td>
<td>

Denies the passages_rekey command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-retry`

</td>
<td>

Enables the passages_retry command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-retry`

</td>
<td>

Denies the passages_retry command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-search`

</td>
<td>

Enables the passages_search command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-search`

</td>
<td>

Denies the passages_search command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:allow-passages-status`

</td>
<td>

Enables the passages_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`passages:deny-passages-status`

</td>
<td>

Denies the passages_status command without any pre-configured scope.

</td>
</tr>
</table>
