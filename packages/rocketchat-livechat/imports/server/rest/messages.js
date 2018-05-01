import LivechatVisitors from '../../../server/models/LivechatVisitors';

RocketChat.API.v1.addRoute('livechat/messages', { authRequired: true }, {
	post() {
		if (!RocketChat.authz.hasPermission(this.userId, 'view-livechat-manager')) {
			return RocketChat.API.v1.unauthorized();
		}

		if (!this.bodyParams.visitor) {
			return RocketChat.API.v1.failure('Body param "visitor" is required');
		}
		if (!this.bodyParams.visitor.token) {
			return RocketChat.API.v1.failure('Body param "visitor.token" is required');
		}
		if (!this.bodyParams.messages) {
			return RocketChat.API.v1.failure('Body param "messages" is required');
		}
		if (!(this.bodyParams.messages instanceof Array)) {
			return RocketChat.API.v1.failure('Body param "messages" is not an array');
		}
		if (this.bodyParams.messages.length === 0) {
			return RocketChat.API.v1.failure('Body param "messages" is empty');
		}

		const visitorToken = this.bodyParams.visitor.token;

		let visitor = LivechatVisitors.getVisitorByToken(visitorToken);
		let rid;
		if (visitor) {
			const rooms = RocketChat.models.Rooms.findOpenByVisitorToken(visitorToken).fetch();
			if (rooms && rooms.length > 0) {
				rid = rooms[0]._id;
			} else {
				rid = Random.id();
			}
		} else {
			rid = Random.id();
			const visitorId = RocketChat.Livechat.registerGuest(this.bodyParams.visitor);
			visitor = LivechatVisitors.findOneById(visitorId);
		}

		const sentMessages = this.bodyParams.messages.map((message) => {
			const sendMessage = {
				guest: visitor,
				message: {
					_id: Random.id(),
					rid,
					token: visitorToken,
					msg: message.msg
				}
			};
			const sentMessage = RocketChat.Livechat.sendMessage(sendMessage);
			return {
				username: sentMessage.u.username,
				msg: sentMessage.msg,
				ts: sentMessage.ts
			};
		});

		return RocketChat.API.v1.success({
			messages: sentMessages
		});
	}
});
