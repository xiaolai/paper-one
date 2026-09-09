## Default Permission

The commands a Paper webview needs from the peer plugin: the endpoint's status,
the device's role, the storage root; the
paired-peer list with grants; pairing (offer, cancel, confirm, dial-from-URI);
sessions (ready, connect, send, recv, close) and blob transfers (fetch, hash);
and the person identity (status, ensure, phrase, restore, forget, delegate) —
WI-22.B1, whose root key never leaves the keychain except as the twelve words a
reader asked to see.
Every path the plugin touches is validated to lie inside the data root, and
every session is accepted only from a persisted peer.

And public sharing (phase 25): what this machine offers by content hash, the
two independent switches per book (its bytes, and public annotations about it),
publishing one annotation record, and asking who else serves a hash. Offering
anything is PUBLICATION into a global index and cannot be undone; withdrawing
stops this machine serving and does not un-tell. Default off, per book, per
service, and asked again on every request.

And the voice (phase 26): the key a reader publishes to strangers under, its
durable sequence, rotation with the old key retained so what it published can
still be withdrawn, and signing. The signing command is confined to
`paper.public.<version>.envelope` bytes exactly as `peer_page_sign` is confined
to circle pages, so neither key can be made to sign the other's.

#### This default permission set includes the following:

- `allow-peer-status`
- `allow-peer-local-role`
- `allow-peer-set-local-role`
- `allow-paper-data-root`
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
- `allow-peer-person-status`
- `allow-peer-person-ensure`
- `allow-peer-person-phrase`
- `allow-peer-person-restore`
- `allow-peer-person-forget`
- `allow-peer-person-delegate`
- `allow-peer-circle-people`
- `allow-peer-circle-introduce`
- `allow-peer-circle-mine`
- `allow-peer-circle-roster`
- `allow-peer-page-sign`
- `allow-peer-circle-remember`
- `allow-peer-circle-revoke`
- `allow-peer-circle-forget`
- `allow-peer-share-offered`
- `allow-peer-share-offer-bytes`
- `allow-peer-share-offer-notes`
- `allow-peer-share-withdraw`
- `allow-peer-share-publish-note`
- `allow-peer-share-resolve`
- `allow-peer-share-fetch`
- `allow-peer-share-fetch-notes`
- `allow-peer-voice-status`
- `allow-peer-voice-next-seq`
- `allow-peer-voice-sign`
- `allow-peer-voice-rotate`
- `allow-peer-voice-sweep`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
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

`peer:allow-peer-circle-forget`

</td>
<td>

Enables the peer_circle_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-forget`

</td>
<td>

Denies the peer_circle_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-circle-introduce`

</td>
<td>

Enables the peer_circle_introduce command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-introduce`

</td>
<td>

Denies the peer_circle_introduce command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-circle-mine`

</td>
<td>

Enables the peer_circle_mine command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-mine`

</td>
<td>

Denies the peer_circle_mine command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-circle-people`

</td>
<td>

Enables the peer_circle_people command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-people`

</td>
<td>

Denies the peer_circle_people command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-circle-remember`

</td>
<td>

Enables the peer_circle_remember command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-remember`

</td>
<td>

Denies the peer_circle_remember command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-circle-revoke`

</td>
<td>

Enables the peer_circle_revoke command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-revoke`

</td>
<td>

Denies the peer_circle_revoke command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-circle-roster`

</td>
<td>

Enables the peer_circle_roster command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-circle-roster`

</td>
<td>

Denies the peer_circle_roster command without any pre-configured scope.

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

`peer:allow-peer-page-sign`

</td>
<td>

Enables the peer_page_sign command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-page-sign`

</td>
<td>

Denies the peer_page_sign command without any pre-configured scope.

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

`peer:allow-peer-person-delegate`

</td>
<td>

Enables the peer_person_delegate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-person-delegate`

</td>
<td>

Denies the peer_person_delegate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-person-ensure`

</td>
<td>

Enables the peer_person_ensure command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-person-ensure`

</td>
<td>

Denies the peer_person_ensure command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-person-forget`

</td>
<td>

Enables the peer_person_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-person-forget`

</td>
<td>

Denies the peer_person_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-person-phrase`

</td>
<td>

Enables the peer_person_phrase command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-person-phrase`

</td>
<td>

Denies the peer_person_phrase command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-person-restore`

</td>
<td>

Enables the peer_person_restore command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-person-restore`

</td>
<td>

Denies the peer_person_restore command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-person-status`

</td>
<td>

Enables the peer_person_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-person-status`

</td>
<td>

Denies the peer_person_status command without any pre-configured scope.

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

`peer:allow-peer-set-local-role`

</td>
<td>

Enables the peer_set_local_role command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-set-local-role`

</td>
<td>

Denies the peer_set_local_role command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-fetch`

</td>
<td>

Enables the peer_share_fetch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-fetch`

</td>
<td>

Denies the peer_share_fetch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-fetch-notes`

</td>
<td>

Enables the peer_share_fetch_notes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-fetch-notes`

</td>
<td>

Denies the peer_share_fetch_notes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-offer-bytes`

</td>
<td>

Enables the peer_share_offer_bytes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-offer-bytes`

</td>
<td>

Denies the peer_share_offer_bytes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-offer-notes`

</td>
<td>

Enables the peer_share_offer_notes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-offer-notes`

</td>
<td>

Denies the peer_share_offer_notes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-offered`

</td>
<td>

Enables the peer_share_offered command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-offered`

</td>
<td>

Denies the peer_share_offered command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-publish-note`

</td>
<td>

Enables the peer_share_publish_note command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-publish-note`

</td>
<td>

Denies the peer_share_publish_note command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-resolve`

</td>
<td>

Enables the peer_share_resolve command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-resolve`

</td>
<td>

Denies the peer_share_resolve command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-share-withdraw`

</td>
<td>

Enables the peer_share_withdraw command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-share-withdraw`

</td>
<td>

Denies the peer_share_withdraw command without any pre-configured scope.

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

<tr>
<td>

`peer:allow-peer-voice-next-seq`

</td>
<td>

Enables the peer_voice_next_seq command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-voice-next-seq`

</td>
<td>

Denies the peer_voice_next_seq command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-voice-rotate`

</td>
<td>

Enables the peer_voice_rotate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-voice-rotate`

</td>
<td>

Denies the peer_voice_rotate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-voice-sign`

</td>
<td>

Enables the peer_voice_sign command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-voice-sign`

</td>
<td>

Denies the peer_voice_sign command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-voice-status`

</td>
<td>

Enables the peer_voice_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-voice-status`

</td>
<td>

Denies the peer_voice_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:allow-peer-voice-sweep`

</td>
<td>

Enables the peer_voice_sweep command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`peer:deny-peer-voice-sweep`

</td>
<td>

Denies the peer_voice_sweep command without any pre-configured scope.

</td>
</tr>
</table>
