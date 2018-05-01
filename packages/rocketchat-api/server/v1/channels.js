import _ from 'underscore';

//Returns the channel IF found otherwise it will return the failure of why it didn't. Check the `statusCode` property
function findChannelByIdOrName({ params, checkedArchived = true, returnUsernames = false }) {
	if ((!params.roomId || !params.roomId.trim()) && (!params.roomName || !params.roomName.trim())) {
		throw new Meteor.Error('error-roomid-param-not-provided', 'The parameter "roomId" or "roomName" is required');
	}

	const fields = { ...RocketChat.API.v1.defaultFieldsToExclude };
	if (returnUsernames) {
		delete fields.usernames;
	}

	let room;
	if (params.roomId) {
		room = RocketChat.models.Rooms.findOneById(params.roomId, { fields });
	} else if (params.roomName) {
		room = RocketChat.models.Rooms.findOneByName(params.roomName, { fields });
	}

	if (!room || room.t !== 'c') {
		throw new Meteor.Error('error-room-not-found', 'The required "roomId" or "roomName" param provided does not match any channel');
	}

	if (checkedArchived && room.archived) {
		throw new Meteor.Error('error-room-archived', `The channel, ${ room.name }, is archived`);
	}

	return room;
}

RocketChat.API.v1.addRoute('channels.addAll', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('addAllUserToRoom', findResult._id, this.bodyParams.activeUsersOnly);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.addModerator', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		const user = this.getUserFromParams();

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('addRoomModerator', findResult._id, user._id);
		});

		return RocketChat.API.v1.success();
	}
});

RocketChat.API.v1.addRoute('channels.addOwner', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		const user = this.getUserFromParams();

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('addRoomOwner', findResult._id, user._id);
		});

		return RocketChat.API.v1.success();
	}
});

RocketChat.API.v1.addRoute('channels.archive', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('archiveRoom', findResult._id);
		});

		return RocketChat.API.v1.success();
	}
});

/**
 DEPRECATED
 // TODO: Remove this after three versions have been released. That means at 0.67 this should be gone.
 **/
RocketChat.API.v1.addRoute('channels.cleanHistory', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		if (!this.bodyParams.latest) {
			return RocketChat.API.v1.failure('Body parameter "latest" is required.');
		}

		if (!this.bodyParams.oldest) {
			return RocketChat.API.v1.failure('Body parameter "oldest" is required.');
		}

		const latest = new Date(this.bodyParams.latest);
		const oldest = new Date(this.bodyParams.oldest);

		let inclusive = false;
		if (typeof this.bodyParams.inclusive !== 'undefined') {
			inclusive = this.bodyParams.inclusive;
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('cleanChannelHistory', { roomId: findResult._id, latest, oldest, inclusive });
		});

		return RocketChat.API.v1.success(this.deprecationWarning({
			endpoint: 'channels.cleanHistory',
			versionWillBeRemove: 'v0.67'
		}));
	}
});

RocketChat.API.v1.addRoute('channels.close', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		const sub = RocketChat.models.Subscriptions.findOneByRoomIdAndUserId(findResult._id, this.userId);

		if (!sub) {
			return RocketChat.API.v1.failure(`The user/callee is not in the channel "${ findResult.name }.`);
		}

		if (!sub.open) {
			return RocketChat.API.v1.failure(`The channel, ${ findResult.name }, is already closed to the sender`);
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('hideRoom', findResult._id);
		});

		return RocketChat.API.v1.success();
	}
});

// Channel -> create

function createChannelValidator(params) {
	if (!RocketChat.authz.hasPermission(params.user.value, 'create-c')) {
		throw new Error('unauthorized');
	}

	if (!params.name || !params.name.value) {
		throw new Error(`Param "${ params.name.key }" is required`);
	}

	if (params.members && params.members.value && !_.isArray(params.members.value)) {
		throw new Error(`Param "${ params.members.key }" must be an array if provided`);
	}

	if (params.customFields && params.customFields.value && !(typeof params.customFields.value === 'object')) {
		throw new Error(`Param "${ params.customFields.key }" must be an object if provided`);
	}
}

function createChannel(userId, params) {
	let readOnly = false;
	if (typeof params.readOnly !== 'undefined') {
		readOnly = params.readOnly;
	}

	let id;
	Meteor.runAsUser(userId, () => {
		id = Meteor.call('createChannel', params.name, params.members ? params.members : [], readOnly, params.customFields);
	});

	return {
		channel: RocketChat.models.Rooms.findOneById(id.rid, { fields: RocketChat.API.v1.defaultFieldsToExclude })
	};
}

RocketChat.API.channels = {};
RocketChat.API.channels.create = {
	validate: createChannelValidator,
	execute: createChannel
};

RocketChat.API.v1.addRoute('channels.create', { authRequired: true }, {
	post() {
		const userId = this.userId;
		const bodyParams = this.bodyParams;

		let error;

		try {
			RocketChat.API.channels.create.validate({
				user: {
					value: userId
				},
				name: {
					value: bodyParams.name,
					key: 'name'
				},
				members: {
					value: bodyParams.members,
					key: 'members'
				}
			});
		} catch (e) {
			if (e.message === 'unauthorized') {
				error = RocketChat.API.v1.unauthorized();
			} else {
				error = RocketChat.API.v1.failure(e.message);
			}
		}

		if (error) {
			return error;
		}

		return RocketChat.API.v1.success(RocketChat.API.channels.create.execute(userId, bodyParams));
	}
});

RocketChat.API.v1.addRoute('channels.delete', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('eraseRoom', findResult._id);
		});

		return RocketChat.API.v1.success({
			channel: findResult
		});
	}
});

RocketChat.API.v1.addRoute('channels.files', { authRequired: true }, {
	get() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });
		const addUserObjectToEveryObject = (file) => {
			if (file.userId) {
				file = this.insertUserObject({ object: file, userId: file.userId });
			}
			return file;
		};

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('canAccessRoom', findResult._id, this.userId);
		});

		const { offset, count } = this.getPaginationItems();
		const { sort, fields, query } = this.parseJsonQuery();

		const ourQuery = Object.assign({}, query, { rid: findResult._id });

		const files = RocketChat.models.Uploads.find(ourQuery, {
			sort: sort ? sort : { name: 1 },
			skip: offset,
			limit: count,
			fields
		}).fetch();

		return RocketChat.API.v1.success({
			files: files.map(addUserObjectToEveryObject),
			count:
			files.length,
			offset,
			total: RocketChat.models.Uploads.find(ourQuery).count()
		});
	}
});

RocketChat.API.v1.addRoute('channels.getIntegrations', { authRequired: true }, {
	get() {
		if (!RocketChat.authz.hasPermission(this.userId, 'manage-integrations')) {
			return RocketChat.API.v1.unauthorized();
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		let includeAllPublicChannels = true;
		if (typeof this.queryParams.includeAllPublicChannels !== 'undefined') {
			includeAllPublicChannels = this.queryParams.includeAllPublicChannels === 'true';
		}

		let ourQuery = {
			channel: `#${ findResult.name }`
		};

		if (includeAllPublicChannels) {
			ourQuery.channel = {
				$in: [ourQuery.channel, 'all_public_channels']
			};
		}

		const { offset, count } = this.getPaginationItems();
		const { sort, fields, query } = this.parseJsonQuery();

		ourQuery = Object.assign({}, query, ourQuery);

		const integrations = RocketChat.models.Integrations.find(ourQuery, {
			sort: sort ? sort : { _createdAt: 1 },
			skip: offset,
			limit: count,
			fields
		}).fetch();

		return RocketChat.API.v1.success({
			integrations,
			count: integrations.length,
			offset,
			total: RocketChat.models.Integrations.find(ourQuery).count()
		});
	}
});

RocketChat.API.v1.addRoute('channels.history', { authRequired: true }, {
	get() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		let latestDate = new Date();
		if (this.queryParams.latest) {
			latestDate = new Date(this.queryParams.latest);
		}

		let oldestDate = undefined;
		if (this.queryParams.oldest) {
			oldestDate = new Date(this.queryParams.oldest);
		}

		let inclusive = false;
		if (this.queryParams.inclusive) {
			inclusive = this.queryParams.inclusive;
		}

		let count = 20;
		if (this.queryParams.count) {
			count = parseInt(this.queryParams.count);
		}

		let unreads = false;
		if (this.queryParams.unreads) {
			unreads = this.queryParams.unreads;
		}

		let result;
		Meteor.runAsUser(this.userId, () => {
			result = Meteor.call('getChannelHistory', {
				rid: findResult._id,
				latest: latestDate,
				oldest: oldestDate,
				inclusive,
				count,
				unreads
			});
		});

		if (!result) {
			return RocketChat.API.v1.unauthorized();
		}

		return RocketChat.API.v1.success(result);
	}
});

RocketChat.API.v1.addRoute('channels.info', { authRequired: true }, {
	get() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.invite', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		const user = this.getUserFromParams();

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('addUserToRoom', { rid: findResult._id, username: user.username });
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.join', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('joinRoom', findResult._id, this.bodyParams.joinCode);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.kick', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		const user = this.getUserFromParams();

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('removeUserFromRoom', { rid: findResult._id, username: user.username });
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.leave', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('leaveRoom', findResult._id);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.list', { authRequired: true }, {
	get: {
		//This is defined as such only to provide an example of how the routes can be defined :X
		action() {
			const { offset, count } = this.getPaginationItems();
			const { sort, fields, query } = this.parseJsonQuery();
			const hasPermissionToSeeAllPublicChannels = RocketChat.authz.hasPermission(this.userId, 'view-c-room');

			const ourQuery = Object.assign({}, query, { t: 'c' });

			if (RocketChat.authz.hasPermission(this.userId, 'view-joined-room') && !hasPermissionToSeeAllPublicChannels) {
				ourQuery.usernames = {
					$in: [this.user.username]
				};
			} else if (!hasPermissionToSeeAllPublicChannels) {
				return RocketChat.API.v1.unauthorized();
			}

			const rooms = RocketChat.models.Rooms.find(ourQuery, {
				sort: sort ? sort : { name: 1 },
				skip: offset,
				limit: count,
				fields
			}).fetch();

			return RocketChat.API.v1.success({
				channels: rooms,
				count: rooms.length,
				offset,
				total: RocketChat.models.Rooms.find(ourQuery).count()
			});
		}
	}
});

RocketChat.API.v1.addRoute('channels.list.joined', { authRequired: true }, {
	get() {
		const { offset, count } = this.getPaginationItems();
		const { sort, fields, query } = this.parseJsonQuery();
		const ourQuery = Object.assign({}, query, {
			t: 'c',
			'u._id': this.userId
		});

		let rooms = _.pluck(RocketChat.models.Subscriptions.find(ourQuery).fetch(), '_room');
		const totalCount = rooms.length;

		rooms = RocketChat.models.Rooms.processQueryOptionsOnResult(rooms, {
			sort: sort ? sort : { name: 1 },
			skip: offset,
			limit: count,
			fields
		});

		return RocketChat.API.v1.success({
			channels: rooms,
			offset,
			count: rooms.length,
			total: totalCount
		});
	}
});

RocketChat.API.v1.addRoute('channels.members', { authRequired: true }, {
	get() {
		const findResult = findChannelByIdOrName({
			params: this.requestParams(),
			checkedArchived: false,
			returnUsernames: true
		});

		const { offset, count } = this.getPaginationItems();
		const { sort } = this.parseJsonQuery();

		const shouldBeOrderedDesc = Match.test(sort, Object) && Match.test(sort.username, Number) && sort.username === -1;

		let members = RocketChat.models.Rooms.processQueryOptionsOnResult(Array.from(findResult.usernames).sort(), {
			skip: offset,
			limit: count
		});

		if (shouldBeOrderedDesc) {
			members = members.reverse();
		}

		const users = RocketChat.models.Users.find({ username: { $in: members } }, {
			fields: { _id: 1, username: 1, name: 1, status: 1, utcOffset: 1 },
			sort: sort ? sort : { username: 1 }
		}).fetch();

		return RocketChat.API.v1.success({
			members: users,
			count: users.length,
			offset,
			total: findResult.usernames.length
		});
	}
});

RocketChat.API.v1.addRoute('channels.messages', { authRequired: true }, {
	get() {
		const findResult = findChannelByIdOrName({
			params: this.requestParams(),
			checkedArchived: false,
			returnUsernames: true
		});
		const { offset, count } = this.getPaginationItems();
		const { sort, fields, query } = this.parseJsonQuery();

		const ourQuery = Object.assign({}, query, { rid: findResult._id });

		//Special check for the permissions
		if (RocketChat.authz.hasPermission(this.userId, 'view-joined-room') && !findResult.usernames.includes(this.user.username)) {
			return RocketChat.API.v1.unauthorized();
		} else if (!RocketChat.authz.hasPermission(this.userId, 'view-c-room')) {
			return RocketChat.API.v1.unauthorized();
		}

		const messages = RocketChat.models.Messages.find(ourQuery, {
			sort: sort ? sort : { ts: -1 },
			skip: offset,
			limit: count,
			fields
		}).fetch();

		return RocketChat.API.v1.success({
			messages,
			count: messages.length,
			offset,
			total: RocketChat.models.Messages.find(ourQuery).count()
		});
	}
});

RocketChat.API.v1.addRoute('channels.online', { authRequired: true }, {
	get() {
		const { query } = this.parseJsonQuery();
		const ourQuery = Object.assign({}, query, { t: 'c' });

		const room = RocketChat.models.Rooms.findOne(ourQuery);

		if (room == null) {
			return RocketChat.API.v1.failure('Channel does not exists');
		}

		const online = RocketChat.models.Users.findUsersNotOffline({
			fields: {
				username: 1
			}
		}).fetch();

		const onlineInRoom = [];
		online.forEach(user => {
			if (room.usernames.indexOf(user.username) !== -1) {
				onlineInRoom.push({
					_id: user._id,
					username: user.username
				});
			}
		});

		return RocketChat.API.v1.success({
			online: onlineInRoom
		});
	}
});

RocketChat.API.v1.addRoute('channels.open', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		const sub = RocketChat.models.Subscriptions.findOneByRoomIdAndUserId(findResult._id, this.userId);

		if (!sub) {
			return RocketChat.API.v1.failure(`The user/callee is not in the channel "${ findResult.name }".`);
		}

		if (sub.open) {
			return RocketChat.API.v1.failure(`The channel, ${ findResult.name }, is already open to the sender`);
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('openRoom', findResult._id);
		});

		return RocketChat.API.v1.success();
	}
});

RocketChat.API.v1.addRoute('channels.removeModerator', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		const user = this.getUserFromParams();

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('removeRoomModerator', findResult._id, user._id);
		});

		return RocketChat.API.v1.success();
	}
});

RocketChat.API.v1.addRoute('channels.removeOwner', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		const user = this.getUserFromParams();

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('removeRoomOwner', findResult._id, user._id);
		});

		return RocketChat.API.v1.success();
	}
});

RocketChat.API.v1.addRoute('channels.rename', { authRequired: true }, {
	post() {
		if (!this.bodyParams.name || !this.bodyParams.name.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "name" is required');
		}

		const findResult = findChannelByIdOrName({ params: { roomId: this.bodyParams.roomId } });

		if (findResult.name === this.bodyParams.name) {
			return RocketChat.API.v1.failure('The channel name is the same as what it would be renamed to.');
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'roomName', this.bodyParams.name);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.setDescription', { authRequired: true }, {
	post() {
		if (!this.bodyParams.description || !this.bodyParams.description.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "description" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		if (findResult.description === this.bodyParams.description) {
			return RocketChat.API.v1.failure('The channel description is the same as what it would be changed to.');
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'roomDescription', this.bodyParams.description);
		});

		return RocketChat.API.v1.success({
			description: this.bodyParams.description
		});
	}
});

RocketChat.API.v1.addRoute('channels.setJoinCode', { authRequired: true }, {
	post() {
		if (!this.bodyParams.joinCode || !this.bodyParams.joinCode.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "joinCode" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'joinCode', this.bodyParams.joinCode);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.setPurpose', { authRequired: true }, {
	post() {
		if (!this.bodyParams.purpose || !this.bodyParams.purpose.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "purpose" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		if (findResult.description === this.bodyParams.purpose) {
			return RocketChat.API.v1.failure('The channel purpose (description) is the same as what it would be changed to.');
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'roomDescription', this.bodyParams.purpose);
		});

		return RocketChat.API.v1.success({
			purpose: this.bodyParams.purpose
		});
	}
});

RocketChat.API.v1.addRoute('channels.setReadOnly', { authRequired: true }, {
	post() {
		if (typeof this.bodyParams.readOnly === 'undefined') {
			return RocketChat.API.v1.failure('The bodyParam "readOnly" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		if (findResult.ro === this.bodyParams.readOnly) {
			return RocketChat.API.v1.failure('The channel read only setting is the same as what it would be changed to.');
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'readOnly', this.bodyParams.readOnly);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.setTopic', { authRequired: true }, {
	post() {
		if (!this.bodyParams.topic || !this.bodyParams.topic.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "topic" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		if (findResult.topic === this.bodyParams.topic) {
			return RocketChat.API.v1.failure('The channel topic is the same as what it would be changed to.');
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'roomTopic', this.bodyParams.topic);
		});

		return RocketChat.API.v1.success({
			topic: this.bodyParams.topic
		});
	}
});

RocketChat.API.v1.addRoute('channels.setAnnouncement', { authRequired: true }, {
	post() {
		if (!this.bodyParams.announcement || !this.bodyParams.announcement.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "announcement" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'roomAnnouncement', this.bodyParams.announcement);
		});

		return RocketChat.API.v1.success({
			announcement: this.bodyParams.announcement
		});
	}
});

RocketChat.API.v1.addRoute('channels.setType', { authRequired: true }, {
	post() {
		if (!this.bodyParams.type || !this.bodyParams.type.trim()) {
			return RocketChat.API.v1.failure('The bodyParam "type" is required');
		}

		const findResult = findChannelByIdOrName({ params: this.requestParams() });

		if (findResult.t === this.bodyParams.type) {
			return RocketChat.API.v1.failure('The channel type is the same as what it would be changed to.');
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('saveRoomSettings', findResult._id, 'roomType', this.bodyParams.type);
		});

		return RocketChat.API.v1.success({
			channel: RocketChat.models.Rooms.findOneById(findResult._id, { fields: RocketChat.API.v1.defaultFieldsToExclude })
		});
	}
});

RocketChat.API.v1.addRoute('channels.unarchive', { authRequired: true }, {
	post() {
		const findResult = findChannelByIdOrName({ params: this.requestParams(), checkedArchived: false });

		if (!findResult.archived) {
			return RocketChat.API.v1.failure(`The channel, ${ findResult.name }, is not archived`);
		}

		Meteor.runAsUser(this.userId, () => {
			Meteor.call('unarchiveRoom', findResult._id);
		});

		return RocketChat.API.v1.success();
	}
});

RocketChat.API.v1.addRoute('channels.getAllUserMentionsByChannel', { authRequired: true }, {
	get() {
		const { roomId } = this.requestParams();
		const { offset, count } = this.getPaginationItems();
		const { sort } = this.parseJsonQuery();

		if (!roomId) {
			return RocketChat.API.v1.failure('The request param "roomId" is required');
		}

		const mentions = Meteor.runAsUser(this.userId, () => Meteor.call('getUserMentionsByChannel', {
			roomId,
			options: {
				sort: sort ? sort : { ts: 1 },
				skip: offset,
				limit: count
			}
		}));

		const allMentions = Meteor.runAsUser(this.userId, () => Meteor.call('getUserMentionsByChannel', {
			roomId,
			options: {}
		}));

		return RocketChat.API.v1.success({
			mentions,
			count: mentions.length,
			offset,
			total: allMentions.length
		});
	}
});

