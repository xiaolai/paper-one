## Default Permission

Paper's own window may export the open book as an audiobook.

The destination is chosen in a native save dialog that this plugin opens
itself, and the window is handed an opaque, single-use token for it rather
than the path — so a grant here is never a grant to write anywhere the reader
did not pick. Scratch audio lives under the app's own data directory, and every
command that touches a file checks the path it was given against the roots the
plugin resolved at startup.

#### This default permission set includes the following:

- `allow-narration-supported`
- `allow-narration-pick`
- `allow-narration-begin`
- `allow-narration-discard-chapter`
- `allow-narration-discard`
- `allow-narrate-package`
- `allow-narration-exists`
- `allow-narration-discard-book`
- `allow-narration-release`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`narration:allow-narrate-package`

</td>
<td>

Enables the narrate_package command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narrate-package`

</td>
<td>

Denies the narrate_package command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-begin`

</td>
<td>

Enables the narration_begin command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-begin`

</td>
<td>

Denies the narration_begin command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-discard`

</td>
<td>

Enables the narration_discard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-discard`

</td>
<td>

Denies the narration_discard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-discard-book`

</td>
<td>

Enables the narration_discard_book command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-discard-book`

</td>
<td>

Denies the narration_discard_book command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-discard-chapter`

</td>
<td>

Enables the narration_discard_chapter command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-discard-chapter`

</td>
<td>

Denies the narration_discard_chapter command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-exists`

</td>
<td>

Enables the narration_exists command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-exists`

</td>
<td>

Denies the narration_exists command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-pick`

</td>
<td>

Enables the narration_pick command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-pick`

</td>
<td>

Denies the narration_pick command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-release`

</td>
<td>

Enables the narration_release command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-release`

</td>
<td>

Denies the narration_release command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:allow-narration-supported`

</td>
<td>

Enables the narration_supported command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`narration:deny-narration-supported`

</td>
<td>

Denies the narration_supported command without any pre-configured scope.

</td>
</tr>
</table>
