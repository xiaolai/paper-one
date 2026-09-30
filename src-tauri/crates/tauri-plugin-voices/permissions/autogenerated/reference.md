## Default Permission

The commands a Paper webview needs from the voices plugin: the catalogue of
downloadable voice packs and which are installed; fetching one, stopping a
fetch, and removing one; reading text aloud through an installed pack; and
letting a loaded model go.

⚠️ FETCHING A PACK IS A NETWORK REQUEST AND A LARGE ONE — up to 2.5 GB from the
hosts the embedded manifest pins by revision. It is never started by anything
but a reader pressing Download, every byte is checked against the manifest's
digest before it is promoted, and a stopped fetch leaves nothing half-installed.
Nothing here can reach a URL the manifest does not name.

Rendering holds a model — about 2.5 GB resident for the Chinese pack — until
`voices_release`, which is why releasing is a command rather than a timer the
webview cannot reach.

⚠️ THE RENDERED READING IS KEPT ON DISK, up to the budget in `clips.rs` — five
gigabytes, which is about 29 hours of audio. `voices_clip_render` writes a file
under the app's own data directory and answers its path; the webview reads it
through the fs plugin's existing `$APPDATA` scope, because a real section is
140 MB of samples and that cannot cross the IPC as a JSON array of numbers.
Nothing here writes outside `audio/`, and every path is built from a digest of
the caller's key rather than from a string the webview chose.

`voices_clip_forget` is how a reader takes that disk back, and
`voices_clip_usage` is what the row in Settings reads.

#### This default permission set includes the following:

- `allow-voices-catalogue`
- `allow-voices-install`
- `allow-voices-stop`
- `allow-voices-remove`
- `allow-voices-render-file`
- `allow-voices-release`
- `allow-voices-clip-find`
- `allow-voices-clip-render`
- `allow-voices-clip-read`
- `allow-voices-clip-hold`
- `allow-voices-clip-usage`
- `allow-voices-clip-forget`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`voices:allow-voices-catalogue`

</td>
<td>

Enables the voices_catalogue command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-catalogue`

</td>
<td>

Denies the voices_catalogue command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-clip-find`

</td>
<td>

Enables the voices_clip_find command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-clip-find`

</td>
<td>

Denies the voices_clip_find command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-clip-forget`

</td>
<td>

Enables the voices_clip_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-clip-forget`

</td>
<td>

Denies the voices_clip_forget command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-clip-hold`

</td>
<td>

Enables the voices_clip_hold command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-clip-hold`

</td>
<td>

Denies the voices_clip_hold command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-clip-read`

</td>
<td>

Enables the voices_clip_read command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-clip-read`

</td>
<td>

Denies the voices_clip_read command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-clip-render`

</td>
<td>

Enables the voices_clip_render command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-clip-render`

</td>
<td>

Denies the voices_clip_render command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-clip-usage`

</td>
<td>

Enables the voices_clip_usage command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-clip-usage`

</td>
<td>

Denies the voices_clip_usage command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-install`

</td>
<td>

Enables the voices_install command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-install`

</td>
<td>

Denies the voices_install command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-release`

</td>
<td>

Enables the voices_release command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-release`

</td>
<td>

Denies the voices_release command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-remove`

</td>
<td>

Enables the voices_remove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-remove`

</td>
<td>

Denies the voices_remove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-render-file`

</td>
<td>

Enables the voices_render_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-render-file`

</td>
<td>

Denies the voices_render_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-stop`

</td>
<td>

Enables the voices_stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-stop`

</td>
<td>

Denies the voices_stop command without any pre-configured scope.

</td>
</tr>
</table>
