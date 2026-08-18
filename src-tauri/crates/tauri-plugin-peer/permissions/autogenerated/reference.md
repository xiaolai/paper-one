## Default Permission

The commands a Paper webview needs from the peer plugin: the endpoint's status,
the device's role, the storage root, fsync of a file inside that root; the
paired-peer list with grants; pairing (offer, cancel, confirm, dial-from-URI);
sessions (ready, connect, send, recv, close) and blob transfers (fetch, hash).
Every path the plugin touches is validated to lie inside the data root, and
every session is accepted only from a persisted peer.

#### This default permission set includes the following:

- `allow-peer-status`
- `allow-peer-local-role`
- `allow-paper-data-root`
- `allow-fs-fsync`
- `allow-peer-list-peers`
- `allow-peer-forget-peer`
- `allow-peer-set-grants`
- `allow-peer-has-grant`
- `allow-peer-pair-begin`
- `allow-peer-pair-cancel`
- `allow-peer-pair-confirm`
- `allow-peer-pair-from-uri`
- `allow-peer-ready`
- `allow-peer-connect`
- `allow-peer-send`
- `allow-peer-session-recv`
- `allow-peer-close`
- `allow-peer-blob-fetch`
- `allow-peer-hash-file`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`peer:allow-fs-fsync`

</td>
<td>

Enables the fs_fsync command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-fs-fsync`

</td>
<td>

Denies the fs_fsync command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-paper-data-root`

</td>
<td>

Enables the paper_data_root command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-paper-data-root`

</td>
<td>

Denies the paper_data_root command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-blob-fetch`

</td>
<td>

Enables the peer_blob_fetch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-blob-fetch`

</td>
<td>

Denies the peer_blob_fetch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-close`

</td>
<td>

Enables the peer_close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-close`

</td>
<td>

Denies the peer_close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-connect`

</td>
<td>

Enables the peer_connect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-connect`

</td>
<td>

Denies the peer_connect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-forget-peer`

</td>
<td>

Enables the peer_forget_peer command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-forget-peer`

</td>
<td>

Denies the peer_forget_peer command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-has-grant`

</td>
<td>

Enables the peer_has_grant command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-has-grant`

</td>
<td>

Denies the peer_has_grant command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-hash-file`

</td>
<td>

Enables the peer_hash_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-hash-file`

</td>
<td>

Denies the peer_hash_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-list-peers`

</td>
<td>

Enables the peer_list_peers command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-list-peers`

</td>
<td>

Denies the peer_list_peers command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-local-role`

</td>
<td>

Enables the peer_local_role command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-local-role`

</td>
<td>

Denies the peer_local_role command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-pair-begin`

</td>
<td>

Enables the peer_pair_begin command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-pair-begin`

</td>
<td>

Denies the peer_pair_begin command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-pair-cancel`

</td>
<td>

Enables the peer_pair_cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-pair-cancel`

</td>
<td>

Denies the peer_pair_cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-pair-confirm`

</td>
<td>

Enables the peer_pair_confirm command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-pair-confirm`

</td>
<td>

Denies the peer_pair_confirm command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-pair-from-uri`

</td>
<td>

Enables the peer_pair_from_uri command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-pair-from-uri`

</td>
<td>

Denies the peer_pair_from_uri command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-ready`

</td>
<td>

Enables the peer_ready command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-ready`

</td>
<td>

Denies the peer_ready command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-send`

</td>
<td>

Enables the peer_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-send`

</td>
<td>

Denies the peer_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-session-recv`

</td>
<td>

Enables the peer_session_recv command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-session-recv`

</td>
<td>

Denies the peer_session_recv command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-set-grants`

</td>
<td>

Enables the peer_set_grants command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-set-grants`

</td>
<td>

Denies the peer_set_grants command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-status`

</td>
<td>

Enables the peer_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-status`

</td>
<td>

Denies the peer_status command without any pre-configured scope.

</td>
</tr>
</table>
